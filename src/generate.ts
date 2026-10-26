import fs from "node:fs";
import path from "node:path";
import { BlobStore } from "@cloudgear/blob";
import { analyzeApp } from "./analyze/app";
import { bundleFunction } from "./build/bundle";
import { encodeConfig, type CloudgearConfig, type FunctionSpec } from "./config/schema";
import { fitName, sanitizeName } from "./names";
import { providerProfile, validateConfigOptions } from "./providers";

export interface GenerateOptions {
  entry: string;
  configPath: string;
  buildDir: string;
  project?: string;
  invokers?: string[];
  reservedConcurrency?: number;
}

const INVOKER = /^(\d{12}|arn:aws[a-z-]*:iam::\d{12}:(root|(user|role)\/.+))$/;

export async function generate(options: GenerateOptions): Promise<{ config: CloudgearConfig; warnings: string[] }> {
  const model = analyzeApp(options.entry);
  const profile = providerProfile(model.provider);
  const project = sanitize(options.project ?? projectName(path.dirname(path.resolve(options.entry))));
  const configDir = path.dirname(path.resolve(options.configPath));
  const fromConfig = (file: string) => path.relative(configDir, path.resolve(file));

  for (const resource of model.resources) {
    if (resource.provider !== model.provider) {
      throw new Error(
        `${resource.file}:${resource.line}: BlobStore "${resource.name}" uses provider "${resource.provider}" but the router uses "${model.provider}"`,
      );
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

  const functions: FunctionSpec[] = [];
  for (const fn of model.functions) {
    const bundle = await bundleFunction({
      name: fn.name,
      sourceFile: fn.file,
      exportName: fn.exportName,
      member: fn.member,
      routes: fn.routes,
      provider: model.provider,
      // Callers of the API domain reach functions with their own requests, so no identity can be vouched for.
      trustContext: model.authenticated === "iam" && !model.api,
      jwt: model.jwt && { settings: { ...model.jwt }, anonymous: !!fn.anonymous },
      outDir: options.buildDir,
    });
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
      permission: used.map((use) => ({
        resource: use.resource,
        path: use.path,
        action: [...new Set([...use.accesses].flatMap((a) => profile.blobStore.actions[a]))].sort(),
      })),
      env: usedResources.map((resource) => ({ key: BlobStore.envVarFor(resource), value_from: resource })),
      reserved_concurrency: reservedConcurrency,
      options: fn.options,
      schedule: fn.schedules.length ? fn.schedules : undefined,
    });
  }

  const config: CloudgearConfig = {
    project,
    provider: model.provider,
    resource: model.resources.map((r) => ({
      name: r.name,
      type: profile.blobStore.type,
      physical_name: r.name,
      dry: r.dry,
      source: `${fromConfig(r.file)}:${r.line}`,
      region: r.region,
      options: r.options,
    })),
    function: functions,
    invoker: invokers,
    authenticated: model.authenticated,
    region: model.region,
    certificate: model.certificates.map((c) => ({
      domain: c.domain,
      dns: c.dns,
      ...(c.usage ? { usage: c.usage } : {}),
      ...(c.region ? { region: c.region } : {}),
      options: c.options,
    })),
    cdn: model.cdn && {
      provider: model.cdn.provider,
      domain: model.cdn.domain,
      bucket: model.cdn.bucket,
      path: model.cdn.path,
      options: model.cdn.options,
    },
    api: model.api,
  };
  if (config.cdn) providerProfile(config.cdn.provider);
  if (config.api) providerProfile(config.api.provider);
  validateConfigOptions(config);

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(options.configPath, encodeConfig(config));
  return { config, warnings: model.warnings };
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
