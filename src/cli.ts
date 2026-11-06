#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { debug, errorSummary, isDebug } from "@cloudgear/debug";
import { createDnsDriver, type DnsProvider } from "@cloudgear/dns";
import { decodeConfig, type CloudgearConfig } from "./config/schema";
import { apply, endpointsFrom, hasEndpoints, providersNeeded, type Drivers } from "./deploy/apply";
import { awsDrivers } from "./deploy/aws";
import { invalidateDistribution } from "./deploy/aws/cloudfront";
import { formatPlan, hasChanges, plan, type PlannedAction } from "./deploy/plan";
import { loadState, saveState, stateKey, type State } from "./deploy/state";
import { INCLUDED_DIR, hashContents, includedPath } from "./build/bundle";
import { generate } from "./generate";
import { baseTags, type Tags } from "./deploy/aws/tags";
import pkg from "../package.json";
import { checkEnvironment, envWarnings } from "./envcheck";
import { checkEnvFileIgnored, parseEnvFile, readSecretRef, secretStatus, setSecrets } from "./secrets";

const USAGE = `Usage: cloudgear <command> [options]

Commands:
  generate <entry.ts>          Analyze the app and write cloudgear.prototxt + function bundles
  plan                         Show what apply would change
  apply [--auto-approve]       Create, update and delete cloud resources to match the config
  import <name> [physical-id]  Adopt an existing resource into state instead of creating it
  invalidate [path...]         Clear the CDN's cache (default: everything)
  destroy [--auto-approve]     Delete every managed resource (imported ones are only forgotten)
  secrets set [NAME] [--from-envfile <file>] [--path <path>] [--all]
                               Store the secrets the app declares (NAME reads its value from stdin)
  secrets list                 Show which declared secrets are stored; values are never printed

Options:
  --config <file>    Config file (default: cloudgear.prototxt)
  --project <name>   Project name used to prefix function names (generate only)
  --invoker <arn>    IAM role/user ARN or account id allowed to call the functions; trusted to assert
                     caller identities, not just to call (generate only, repeatable)
  --reserved-concurrency <n>  Cap each function's concurrent executions (generate only)
  --region <region>  Cloud region (default: $AWS_REGION / $AWS_DEFAULT_REGION)
  --env <name>       Environment tag for created resources, e.g. prod (apply only)
  --author <name>    Author tag (default: git user.name, then $USER) (apply only)
  --tag <key=value>  Extra tag on created resources, repeatable (apply only)
  --skip-env-check   Deploy even if the code reads environment variables nothing provides, or secrets are not stored (apply only)
  --from-envfile <file>  Dotenv file to load secrets from (secrets set); it MUST be git-ignored
  --allow-unignored  Load an env file git does not ignore (secrets set)
  --path <path>      Restrict secrets set to one declared path
  --all              Also store undeclared names from the env file under the path (secrets set)
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", default: "cloudgear.prototxt" },
      project: { type: "string" },
      invoker: { type: "string", multiple: true },
      "reserved-concurrency": { type: "string" },
      region: { type: "string" },
      env: { type: "string" },
      author: { type: "string" },
      tag: { type: "string", multiple: true },
      "from-envfile": { type: "string" },
      "allow-unignored": { type: "boolean", default: false },
      "skip-env-check": { type: "boolean", default: false },
      path: { type: "string" },
      all: { type: "boolean", default: false },
      "auto-approve": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    process.exit(command || values.help ? 0 : 1);
  }

  const configPath = path.resolve(values.config!);
  const workDir = path.join(path.dirname(configPath), ".cloudgear");
  const statePath = path.join(workDir, "state.json");
  debug("cli", `command ${command}`, { args, config: configPath, state: statePath, cwd: process.cwd(), region: values.region });
  if (isDebug()) {
    debug("cli", "environment", {
      CLOUDGEAR_DNS_DRIVER: process.env.CLOUDGEAR_DNS_DRIVER,
      CLOUDGEAR_BLOB_DRIVER: process.env.CLOUDGEAR_BLOB_DRIVER,
      CLOUDGEAR_CERT_DRIVER: process.env.CLOUDGEAR_CERT_DRIVER,
      CLOUDGEAR_CDN_DRIVER: process.env.CLOUDGEAR_CDN_DRIVER,
      AWS_REGION: process.env.AWS_REGION,
      AWS_PROFILE: process.env.AWS_PROFILE,
    });
  }

  switch (command) {
    case "generate": {
      const entry = args[0];
      if (!entry) throw new Error("Usage: cloudgear generate <entry.ts>");
      const { config, warnings } = await generate({
        entry,
        configPath,
        buildDir: path.join(workDir, "build"),
        project: values.project,
        invokers: values.invoker,
        reservedConcurrency: values["reserved-concurrency"] === undefined ? undefined : Number(values["reserved-concurrency"]),
      });
      for (const warning of warnings) console.warn(`warning: ${warning}`);
      console.log(
        `cloudgear: ${config.function.length} function(s), ${config.resource.length} resource(s) -> ${path.relative(process.cwd(), configPath)}`,
      );
      return;
    }
    case "plan": {
      const config = readConfig(configPath);
      const state = loadState(statePath, config.project, config.provider);
      debug("cli", "state loaded", { entries: Object.keys(state.entries).length });
      console.log(formatPlan(plan(config, state)));
      const warning = envWarnings(config, configPath);
      if (warning) console.warn(`\nwarning: ${warning}`);
      return;
    }
    case "apply":
    case "destroy": {
      const config = readConfig(configPath);
      const state = loadState(statePath, config.project, config.provider);
      const target =
        command === "destroy"
          ? { ...config, resource: [], function: [], certificate: [], cdn: undefined, api: undefined }
          : config;
      const actions = plan(target, state);
      debug("cli", "planned", () => {
        const counts: Record<string, number> = {};
        for (const a of actions) counts[a.op] = (counts[a.op] ?? 0) + 1;
        return counts;
      });
      console.log(formatPlan(actions));
      if (command === "apply" && config.function.length && !values["skip-env-check"]) {
        await checkEnvironment(config, configPath, values.region);
      }
      if (!hasChanges(actions)) {
        console.log("\nNo changes.");
      } else {
        if (!values["auto-approve"] && !confirm(`\nDo you want to ${command}?`)) {
          console.log("Cancelled.");
          return;
        }
        try {
          await apply(actions, state, await drivers(actions, config, configPath, values.region, deployTags(config, configPath, values)), {
            save: (s) => saveState(statePath, s),
            log: (message) => console.log(`cloudgear: ${message}`),
          });
          console.log(`cloudgear: ${command} complete`);
          for (const entry of command === "apply" ? Object.values(state.entries) : []) {
            if (entry.type === "@aws.ApiGateway" && entry.outputs.url) {
              console.log(`cloudgear: api ${entry.outputs.url} (${entry.outputs.domain_name})`);
              continue;
            }
            if (entry.type !== "@aws.CloudFront" || !entry.outputs.domain_name) continue;
            const status = entry.outputs.status === "Deployed" ? "live" : "still deploying";
            console.log(`cloudgear: site https://${entry.name} (${status}; distribution ${entry.outputs.id}, ${entry.outputs.domain_name})`);
          }
        } finally {
          writeEndpoints(config, state, workDir);
        }
        return;
      }
      writeEndpoints(config, state, workDir);
      return;
    }
    case "invalidate": {
      const config = readConfig(configPath);
      const state = loadState(statePath, config.project, config.provider);
      const distribution = Object.values(state.entries).find((entry) => entry.type === "@aws.CloudFront" && entry.name !== config.api?.domain);
      if (!distribution?.outputs.id) throw new Error("No CDN has been deployed; run `cloudgear apply` first");
      const paths = args.length ? args : ["/*"];
      for (const p of paths) if (!p.startsWith("/")) throw new Error(`Invalidation path "${p}" must start with "/"`);
      const id = await invalidateDistribution(new CloudFrontClient({ region: "us-east-1" }), distribution.outputs.id, paths);
      console.log(`cloudgear: invalidation ${id} started for ${paths.join(", ")}`);
      return;
    }
    case "secrets": {
      const [sub, name] = args;
      const config = readConfig(configPath);
      const region = config.region || values.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
      if (sub === "list") {
        for (const status of await secretStatus(config, region)) {
          console.log(`${status.group.path} (${status.group.service})${status.group.all ? " [all]" : ""}`);
          for (const n of status.present) console.log(`  ok       ${n}`);
          for (const n of status.missing) console.log(`  missing  ${n}`);
          for (const n of status.unused) console.log(`  unused   ${n}`);
        }
        return;
      }
      if (sub !== "set") throw new Error("Usage: cloudgear secrets set|list");
      let input: Record<string, string>;
      if (values["from-envfile"]) {
        if (name) throw new Error("Pass either NAME or --from-envfile, not both");
        checkEnvFileIgnored(values["from-envfile"], values["allow-unignored"]!);
        input = parseEnvFile(fs.readFileSync(values["from-envfile"], "utf8"), values["from-envfile"]);
      } else if (name) {
        input = { [name]: (await Bun.stdin.text()).replace(/\r?\n$/, "") };
      } else {
        throw new Error("Usage: cloudgear secrets set <NAME> (value on stdin) | --from-envfile <file>");
      }
      const result = await setSecrets(config, input, { region, only: name, all: values.all, path: values.path });
      for (const w of result.written) console.log(`cloudgear: stored ${w.names.join(", ")} under ${w.path}`);
      if (!result.written.length) console.log("cloudgear: nothing stored");
      if (result.missing.length) console.warn(`warning: not provided: ${result.missing.join(", ")}`);
      if (result.empty.length) console.warn(`warning: empty values skipped: ${result.empty.join(", ")}`);
      if (result.undeclared.length) console.warn(`warning: declared nowhere, skipped (use --all to store): ${result.undeclared.join(", ")}`);
      return;
    }
    case "import": {
      const [name, physicalId] = args;
      if (!name) throw new Error("Usage: cloudgear import <name> [physical-id]");
      const config = readConfig(configPath);
      const resource = config.resource.find((r) => r.name === name);
      if (!resource) {
        const known = config.resource.map((r) => r.name).join(", ") || "none";
        throw new Error(`No resource named "${name}" in ${values.config} (resources: ${known}); functions cannot be imported`);
      }
      const state = loadState(statePath, config.project, config.provider);
      const existing = state.entries[stateKey(resource)];
      if (existing && !existing.imported) {
        throw new Error(`${resource.type} ${name} is already managed by cloudgear; destroy it before importing another`);
      }
      const physical = physicalId ?? resource.physical_name;
      state.entries[stateKey(resource)] = {
        kind: "resource",
        type: resource.type,
        name: resource.name,
        physical_name: physical,
        imported: true,
        spec: { physical_name: physical },
        outputs: {},
      };
      saveState(statePath, state);
      console.log(`cloudgear: imported ${resource.type} ${resource.name} as "${physical}"`);
      return;
    }
    default:
      throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

function writeEndpoints(config: CloudgearConfig, state: State, workDir: string): void {
  const endpointsPath = path.join(workDir, "endpoints.json");
  const endpoints = endpointsFrom(config, state);
  if (hasEndpoints(endpoints)) {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(endpointsPath, JSON.stringify(endpoints, null, 2) + "\n");
    console.log(`cloudgear: endpoints -> ${path.relative(process.cwd(), endpointsPath)}`);
  } else {
    fs.rmSync(endpointsPath, { force: true });
    console.log("cloudgear: no deployed endpoints");
  }
}

function readConfig(configPath: string): CloudgearConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`${path.relative(process.cwd(), configPath)} not found; run \`cloudgear generate <entry.ts>\` first`);
  }
  return decodeConfig(fs.readFileSync(configPath, "utf8"));
}

// One deployer set per provider the planned actions touch.
function gitUserName(cwd: string): string {
  try {
    return Bun.spawnSync(["git", "config", "user.name"], { cwd, stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  } catch {
    return "";
  }
}

function deployTags(config: CloudgearConfig, configPath: string, values: { env?: string; author?: string; tag?: string[] }): Tags {
  const extra: Tags = {};
  for (const pair of values.tag ?? []) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(`--tag expects key=value, got "${pair}"`);
    extra[pair.slice(0, at)] = pair.slice(at + 1);
  }
  const author = values.author ?? (gitUserName(path.dirname(configPath)) || process.env.USER);
  return baseTags({ project: config.project, version: pkg.version, env: values.env, author, extra });
}

async function drivers(actions: PlannedAction[], config: CloudgearConfig, configPath: string, region: string | undefined, tags: Tags): Promise<Drivers> {
  const providers = providersNeeded(actions);
  debug("cli", "providers", { providers });
  const all: Drivers = {};
  for (const provider of providers) {
    const factory = DEPLOYERS[provider];
    if (!factory) throw new Error(`Provider "${provider}" has no deploy drivers yet; the config can be planned but not applied`);
    Object.assign(all, await factory(config, configPath, region, tags));
  }
  return all;
}

const DEPLOYERS: Record<string, (config: CloudgearConfig, configPath: string, region: string | undefined, tags: Tags) => Promise<Drivers>> = {
  aws: awsDeployers,
};

async function awsDeployers(config: CloudgearConfig, configPath: string, region: string | undefined, tags: Tags): Promise<Drivers> {
  // The router's own `region` option wins, then --region, then the environment.
  const resolvedRegion = config.region || region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  debug("cli", "region", { fromConfig: config.region, flag: region, env: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION, resolved: resolvedRegion });
  if (!resolvedRegion) throw new Error("Set the router's region option, --region or AWS_REGION to deploy");
  const configDir = path.dirname(configPath);
  const verified = new Map<string, { name: string; data: Uint8Array }[]>();
  // Credentials (for example GANDI_TOKEN) are read from the environment when the first record is written.
  if (process.env.CLOUDGEAR_DNS_DRIVER === "memory") {
    console.warn("warning: CLOUDGEAR_DNS_DRIVER=memory is set; no real DNS records will be written");
  }
  return awsDrivers({
    region: resolvedRegion,
    tags,
    dns: async (provider, zone, token) =>
      createDnsDriver(provider as DnsProvider, zone, token ? { token: await readSecretRef(token, resolvedRegion) } : undefined),
    log: (message) => console.log(`cloudgear: ${message}`),
    readBundle: (fn) => {
      const file = path.resolve(configDir, fn.bundle.path);
      const filesDir = path.join(path.dirname(file), INCLUDED_DIR);
      const index = new Uint8Array(fs.readFileSync(file));
      const files = (fn.include ?? []).map((rel) => ({ name: rel, data: new Uint8Array(fs.readFileSync(includedPath(filesDir, rel))) }));
      if (hashContents(index, files.map((f) => ({ rel: f.name, data: f.data }))) !== fn.bundle.sha256) {
        throw new Error(`${fn.bundle.path} does not match the config's sha256; re-run \`cloudgear generate\``);
      }
      verified.set(fn.physical_name, files);
      return index;
    },
    readIncluded: (fn) => {
      const files = verified.get(fn.physical_name);
      if (!files) throw new Error(`${fn.physical_name}: its bundle has not been verified yet`);
      return files;
    },
  });
}

main().catch((err) => {
  console.error(`cloudgear: ${err instanceof Error ? err.message : err}`);
  if (isDebug()) {
    debug("cli", `failed: ${errorSummary(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
  }
  process.exit(1);
});
