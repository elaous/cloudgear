import fs from "node:fs";
import path from "node:path";
import { BlobStore } from "@cloudgear/blob";
import { debug, timed } from "@cloudgear/debug";
import { EventBus } from "@cloudgear/events";
import { analyzeApp, type AnalyzedFunction, type SecretBindingModel, type SecretRefModel } from "./analyze/app";
import { bundleFunction } from "./build/bundle";
import { encodeConfig, type CloudgearConfig, type FunctionSpec, type SecretBindingSpec, type SecretRefSpec } from "./config/schema";
import { configHash, envReportPath, type EnvReport, type EnvSource } from "./envreport";
import { fitName, sanitizeName } from "./names";
import { capability, crossProviderAccess, environmentOptions, providerProfile, validateConfigOptions } from "./providers";

// Set by the Lambda runtime, or ambient in every Node program.
const PLATFORM_ENV = new Set(["TZ", "LANG", "PATH", "LD_LIBRARY_PATH", "NODE_PATH", "NODE_ENV", "CI"]);

export interface GenerateOptions {
  entry: string;
  configPath: string;
  buildDir: string;
  project?: string;
  invokers?: string[];
  reservedConcurrency?: number;
}

const MAX_INCLUDED_BYTES = 250 * 1024 * 1024;
const WARN_INCLUDED_BYTES = 40 * 1024 * 1024;
const INVOKER = /^(\d{12}|arn:aws[a-z-]*:iam::\d{12}:(root|(user|role)\/.+))$/;

export async function generate(options: GenerateOptions): Promise<{ config: CloudgearConfig; warnings: string[] }> {
  const model = await timed("generate", `analyze ${options.entry}`, async () => analyzeApp(options.entry));
  debug("generate", "analyzed", () => ({
    provider: model.provider,
    region: model.region,
    resources: model.resources.map((r) => ({ name: r.name, dry: r.dry, region: r.region, options: r.options })),
    functions: model.functions.map((f) => ({
      name: f.name,
      file: f.file,
      routes: f.routes.map((r) => `${r.method} ${r.path}`),
      schedules: f.schedules.map((s) => (s.query ? `${s.cron} ?${new URLSearchParams(s.query)}` : s.cron)),
      uses: [...f.uses.values()].map((u) => ({ resource: u.resource, path: u.path, accesses: [...u.accesses] })),
    })),
    certificates: model.certificates.map((c) => ({ domain: c.domain, usage: c.usage, region: c.region })),
    cdn: model.cdns.map((c) => c.domain),
    api: model.api?.domain,
    warnings: model.warnings.length,
  }));
  const profile = providerProfile(model.provider);
  const warnings = [...model.warnings];
  const project = sanitize(options.project ?? projectName(path.dirname(path.resolve(options.entry))));
  const configDir = path.dirname(path.resolve(options.configPath));
  const fromConfig = (file: string) => path.relative(configDir, path.resolve(file));

  for (const fn of model.functions) {
    if (fn.schedules.length) capability(model.provider, "schedule");
  }

  const resourceProvider = new Map(model.resources.map((r) => [r.name, r.provider]));
  for (const fn of model.functions) {
    for (const use of fn.uses.values()) {
      const storeProvider = resourceProvider.get(use.resource);
      if (storeProvider && storeProvider !== model.provider && !crossProviderAccess(model.provider, storeProvider)) {
        warnings.push(
          `${fn.file}: "${fn.name}" (${model.provider}) uses BlobStore "${use.resource}" (${storeProvider}); cross-provider access is not provisioned yet, so the function gets no credentials for it`,
        );
      }
    }
  }

  const envVars = new Map<string, string>();
  for (const resource of model.resources) {
    const envVar = BlobStore.envVarFor(resource.name);
    const clash = envVars.get(envVar);
    if (clash) throw new Error(`BlobStores "${clash}" and "${resource.name}" map to the same env var ${envVar}; rename one`);
    envVars.set(envVar, resource.name);
  }

  const physicalNames = new Map<string, string>();
  for (const fn of model.functions) {
    const physical = fitName(`${project}-${sanitizeName(fn.name)}`, 64);
    const clash = physicalNames.get(physical);
    if (clash) throw new Error(`Functions "${clash}" and "${fn.name}" both deploy as "${physical}"; rename one`);
    physicalNames.set(physical, fn.name);
  }

  const invokers = [...new Set(options.invokers ?? [])].sort();
  for (const invoker of invokers) {
    if (!INVOKER.test(invoker)) {
      throw new Error(`Invalid invoker "${invoker}"; expected an IAM role/user ARN or a 12-digit account id`);
    }
  }
  const reservedConcurrency = options.reservedConcurrency ?? 0;
  if (!Number.isInteger(reservedConcurrency) || reservedConcurrency < 0) {
    throw new Error(`Invalid reserved concurrency "${reservedConcurrency}"; expected a non-negative integer`);
  }

  const busResource = (name: string) => `bus.${name}`;
  const busPhysical = new Map<string, string>();
  const busEnv = new Map<string, string>();
  for (const bus of model.buses) {
    const physical = bus.name === "default" ? "default" : fitName(`${project}-${sanitizeName(bus.name)}`, 64);
    const physicalClash = busPhysical.get(physical);
    if (physicalClash) throw new Error(`EventBus "${physicalClash}" and "${bus.name}" both deploy as "${physical}"; rename one`);
    busPhysical.set(physical, bus.name);
    const envClash = busEnv.get(EventBus.envVarFor(bus.name));
    if (envClash) throw new Error(`EventBus "${envClash}" and "${bus.name}" map to the same env var ${EventBus.envVarFor(bus.name)}; rename one`);
    busEnv.set(EventBus.envVarFor(bus.name), bus.name);
  }
  for (const fn of model.functions) {
    for (const bus of new Set(fn.events.map((e) => e.bus).filter((name) => fn.publishes.includes(name)))) {
      warnings.push(`${fn.file}: "${fn.name}" runs on events of bus "${bus}" and publishes to it; make sure it never publishes the event type it handles, or it will run forever`);
    }
  }
  const functions: FunctionSpec[] = [];
  for (const fn of model.functions) {
    if (model.provider !== "aws" && (fn.include.length || fn.passRequest || fn.responseKind)) {
      throw new Error(`${fn.file}: include, request and response are not supported for provider "${model.provider}" yet`);
    }
    const includedBytes = fn.include.reduce((sum, file) => sum + fs.statSync(file.abs).size, 0);
    if (includedBytes > MAX_INCLUDED_BYTES) {
      throw new Error(`${fn.file}: the files included in "${fn.name}" are ${Math.ceil(includedBytes / 1e6)} MB; a function package is limited to 250 MB unzipped`);
    }
    if (includedBytes > WARN_INCLUDED_BYTES) {
      warnings.push(`${fn.file}: the files included in "${fn.name}" are ${Math.ceil(includedBytes / 1e6)} MB; a zipped package over 50 MB cannot be uploaded directly`);
    }
    if (model.provider !== "aws" && (fn.events.length || fn.publishes.length)) {
      throw new Error(`${fn.file}: EventBus is not supported for provider "${model.provider}" yet`);
    }
    checkSecrets(fn, model.provider, profile.reservedEnv, warnings);
    const hydrated = fn.secrets.filter((s) => s.env || s.all);
    const bundle = await timed("generate", `bundle ${fn.name}`, () => bundleFunction({
      name: fn.name,
      sourceFile: fn.file,
      exportName: fn.exportName,
      member: fn.member,
      routes: fn.routes,
      provider: model.provider,
      // Callers of the API domain reach functions with their own requests, so no identity can be vouched for.
      trustContext: model.provider === "aws" && model.authenticated === "iam" && !model.api,
      jwt: model.jwt && { settings: { ...model.jwt }, anonymous: !!fn.anonymous },
      include: fn.include,
      passRequest: fn.passRequest,
      responseKind: fn.responseKind,
      secrets: hydrated.length
        ? {
            bindings: hydrated.map((s) => ({ provider: s.provider, service: s.service, ...(s.region ? { region: s.region } : {}), path: s.path, name: s.name, env: s.env, ...(s.all ? { all: true } : {}) })),
            services: [...new Set(hydrated.map((s) => s.service))].sort(),
          }
        : undefined,
      outDir: options.buildDir,
    }));
    debug("generate", `bundled ${fn.name}`, () => ({ file: bundle.file, sha256: bundle.sha256, bytes: fs.statSync(bundle.file).size }));
    const used = [...fn.uses.values()].filter((use) => use.accesses.size > 0);
    const usedResources = [...new Set(used.map((use) => use.resource))];
    functions.push({
      name: fn.name,
      type: profile.function.type,
      physical_name: fitName(`${project}-${sanitizeName(fn.name)}`, 64),
      runtime: profile.function.runtime,
      memory_mb: profile.function.memoryMb,
      timeout_s: profile.function.timeoutS,
      source: { file: fromConfig(fn.file), export: fn.exportName, member: fn.member, input_type: fn.inputType },
      route: fn.routes,
      bundle: { path: fromConfig(bundle.file), sha256: bundle.sha256 },
      permission: [
        ...used.map((use) => ({
          resource: use.resource,
          path: use.path,
          action: [...new Set([...use.accesses].flatMap((a) => providerProfile(resourceProvider.get(use.resource) ?? model.provider).blobStore.actions[a]))].sort(),
        })),
        ...fn.publishes.map((bus) => ({ resource: busResource(bus), path: "", action: ["events:PutEvents"] })),
      ],
      env: [
        ...usedResources.map((resource) => ({ key: BlobStore.envVarFor(resource), value_from: resource })),
        ...fn.publishes.map((bus) => ({ key: EventBus.envVarFor(bus), value_from: busResource(bus) })),
      ],
      reserved_concurrency: reservedConcurrency,
      options: fn.options,
      schedule: fn.schedules.some((s) => !s.query) ? fn.schedules.filter((s) => !s.query).map((s) => s.cron) : undefined,
      query_schedule: fn.schedules.some((s) => s.query) ? fn.schedules.filter((s) => s.query).map((s) => ({ cron: s.cron, query: s.query! })) : undefined,
      include: fn.include.length ? fn.include.map((f) => f.rel) : undefined,
      pass_request: fn.passRequest || undefined,
      response_arg: fn.responseKind,
      secret: fn.secrets.length ? fn.secrets.map(bindingSpec) : undefined,
      event: fn.events.length ? fn.events.map((e) => ({ bus: busResource(e.bus), type: e.type, ...(e.source !== undefined ? { source: e.source } : {}) })) : undefined,
    });
  }

  const config: CloudgearConfig = {
    project,
    provider: model.provider,
    resource: model.resources.map((r) => ({
      name: r.name,
      type: providerProfile(r.provider).blobStore.type,
      physical_name: r.name,
      dry: r.dry,
      source: `${fromConfig(r.file)}:${r.line}`,
      region: r.region,
      options: r.options,
    })).concat(
      model.buses.map((bus) => ({
        name: busResource(bus.name),
        type: capability(model.provider, "events").type,
        physical_name: bus.name === "default" ? "default" : fitName(`${project}-${sanitizeName(bus.name)}`, 64),
        dry: bus.name === "default",
        source: `${fromConfig(bus.file)}:${bus.line}`,
        region: undefined,
        options: undefined,
      })),
    ),
    function: functions,
    invoker: invokers,
    authenticated: model.authenticated,
    region: model.region,
    certificate: model.certificates.map((c) => ({
      provider: c.provider,
      domain: c.domain,
      dns: { ...c.dns, ...(c.dns.token ? { token: refSpec(c.dns.token) } : {}) },
      ...(c.usage ? { usage: c.usage } : {}),
      ...(c.region ? { region: c.region } : {}),
      options: c.options,
    })),
    cdn: model.cdns.map((cdn) => ({ provider: cdn.provider, domain: cdn.domain, bucket: cdn.bucket, path: cdn.path, options: cdn.options })),
    api: model.api,
  };
  for (const cdn of config.cdn) providerProfile(cdn.provider);
  if (config.api) providerProfile(config.api.provider);
  validateConfigOptions(config);

  const configText = encodeConfig(config);
  const report: EnvReport = { version: 1, config: configHash(configText), functions: {} };
  for (const name of model.optionalEnv) {
    if (!model.functions.some((fn) => name in fn.envUse.variables)) warnings.push(`optionalEnv "${name}" is not read by any function; check the spelling`);
  }
  model.functions.forEach((fn, index) => {
    const spec = functions[index]!;
    const optionEnv = environmentOptions(fn.options);
    const provided = (name: string): EnvSource =>
      spec.env.some((e) => e.key === name) ? "resource"
      : name in optionEnv ? "option"
      : fn.secrets.some((s) => s.env === name) ? "secret"
      : fn.secrets.some((s) => s.all) ? "secret-wildcard"
      : profile.reservedEnv.test(name) || PLATFORM_ENV.has(name) ? "platform"
      : null;
    report.functions[fn.name] = {
      routes: fn.routes.map((r) => `${r.method} ${r.path}`),
      variables: Object.fromEntries(Object.entries(fn.envUse.variables).map(([name, use]) => [name, { ...use, required: use.required && !model.optionalEnv.includes(name), provided: provided(name) }])),
      dynamic: fn.envUse.dynamic,
    };
    if (fn.envUse.dynamic.length) warnings.push(`${fn.file}: "${fn.name}" reads the environment in ways that cannot be listed (${fn.envUse.dynamic.join(", ")}); those variables are not checked`);
  });

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(options.configPath, configText);
  fs.writeFileSync(envReportPath(options.configPath), `${JSON.stringify(report, null, 2)}\n`);
  debug("generate", "config written", { path: options.configPath, functions: config.function.length, resources: config.resource.length });
  if (functions.some((f) => f.secret?.length) || config.certificate.some((c) => c.dns.token)) {
    for (const file of trackedEnvFiles(path.dirname(path.resolve(options.entry)))) {
      warnings.push(`${file} is tracked by git; keep env files out of the repository (add them to .gitignore) and load them with \`cloudgear secrets set\``);
    }
  }
  return { config, warnings: [...new Set(warnings)] };
}

const refSpec = (s: SecretRefModel): SecretRefSpec => ({
  provider: s.provider,
  service: s.service,
  ...(s.region ? { region: s.region } : {}),
  ...(s.kmsKey ? { kms_key: s.kmsKey } : {}),
  path: s.path,
  name: s.name,
});

const bindingSpec = (s: SecretBindingModel): SecretBindingSpec => ({ ...refSpec(s), env: s.env, ...(s.all ? { all: true } : {}) });

const SECRETISH = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY/i;

// The environment a function gets must be unambiguous, and secrets do not belong in plain options.
function checkSecrets(fn: AnalyzedFunction, provider: string, reserved: RegExp, warnings: string[]): void {
  const targets = new Map<string, string>();
  for (const binding of fn.secrets.filter((s) => s.env)) {
    if (reserved.test(binding.env)) throw new Error(`${fn.file}: "${fn.name}" cannot fill ${binding.env}; it is reserved by the platform`);
    const target = `${binding.path}/${binding.name}`;
    const clash = targets.get(binding.env);
    if (clash && clash !== target) throw new Error(`${fn.file}: "${fn.name}" fills ${binding.env} from both ${clash} and ${target}`);
    targets.set(binding.env, target);
    if (fn.options?.[`env.${binding.env}`] !== undefined) {
      throw new Error(`${fn.file}: "${fn.name}" sets ${binding.env} as a plain env option and as a secret; keep one`);
    }
  }
  for (const binding of fn.secrets.filter((s) => s.all)) {
    warnings.push(`${fn.file}: "${fn.name}" reads every secret under ${binding.path}; list the names to grant only those`);
  }
  for (const key of Object.keys(fn.options ?? {})) {
    if (key.startsWith("env.") && SECRETISH.test(key.slice(4))) {
      warnings.push(`${fn.file}: "${fn.name}" sets ${key} as a plain option, which is committed and readable on the function; use a SecretStore for secrets`);
    }
  }
  if (fn.secrets.length && provider !== "aws") {
    warnings.push(`${fn.file}: "${fn.name}" (${provider}) reads AWS secrets; cross-provider access is not provisioned yet, so the function gets no credentials for them`);
  }
}

// Env files committed to git are the one way a secret set by `cloudgear secrets set` reaches the repository.
function trackedEnvFiles(dir: string): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "--", ".env*", "*.env"], { cwd: dir, stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().split("\n").filter(Boolean) : [];
}

function projectName(dir: string): string {
  const pkg = path.join(dir, "package.json");
  if (fs.existsSync(pkg)) {
    const name = JSON.parse(fs.readFileSync(pkg, "utf8")).name;
    if (typeof name === "string" && name) return name;
  }
  return path.basename(dir);
}

function sanitize(name: string): string {
  return name.replace(/^@/, "").replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "app";
}
