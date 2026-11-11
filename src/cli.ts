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
import { adoptByArn, adoptEntries, typeOfArn } from "./deploy/adopt";
import { parseArn } from "./deploy/aws/arn";
import { pickDistribution, siteDistributions } from "./cdnselect";
import { checkEnvironment, envWarnings } from "./envcheck";
import { checkEnvFileIgnored, parseEnvFile, readSecretRef, secretStatus, setSecrets } from "./secrets";

const USAGE = `Usage: cloudgear <command> [options]

Commands:
  generate <entry.ts>          Analyze the app and write cloudgear.prototxt + function bundles
  plan                         Show what apply would change
  apply [--auto-approve]       Create, update and delete cloud resources to match the config
  import <name> [physical-id]  Adopt an existing bucket, function, certificate, distribution or schedule into state
  import <type> <name>         The same, when several things share a name (for example @aws.Certificate www.example.com)
  import --all                 Adopt everything planned that already exists; the rest is created by apply
  invalidate [path...] [--domain <cdn>]  Clear a CDN's cache (default: everything)
  destroy [--auto-approve]     Delete every managed resource (imported buckets are only forgotten)
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
  --domain <domain>  Which CDN to invalidate when the app has several
  --arn <arn>        Import exactly this certificate, distribution, function, rule or bucket (import only)
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
      domain: { type: "string" },
      arn: { type: "string" },
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
          ? { ...config, resource: [], function: [], certificate: [], cdn: [], api: undefined }
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
      const distribution = pickDistribution(siteDistributions(config, state), values.domain);
      const paths = args.length ? args : ["/*"];
      for (const p of paths) if (!p.startsWith("/")) throw new Error(`Invalidation path "${p}" must start with "/"`);
      const id = await invalidateDistribution(new CloudFrontClient({ region: "us-east-1" }), distribution.outputs.id!, paths);
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
      const config = readConfig(configPath);
      const state = loadState(statePath, config.project, config.provider);
      const [first, second, third] = args;
      if (!values.all && !first && !values.arn) throw new Error("Usage: cloudgear import <name> [physical-id] | cloudgear import <type> <name> | cloudgear import --arn <arn> | cloudgear import --all");
      if (values.arn !== undefined && !values.arn.startsWith("arn:")) throw new Error(`--arn "${values.arn}" is not an ARN`);
      // The ARN says what kind of thing it is.
      const arnType = values.arn ? typeOfArn(values.arn) : undefined;
      const arnBucket = !values.all && !first && arnType === "@aws.S3" ? bucketOfArn(values.arn!) : undefined;
      const bucket = !values.all && first && !first.startsWith("@") ? config.resource.find((r) => r.name === first) : arnBucket ? config.resource.find((r) => r.name === arnBucket || r.physical_name === arnBucket) : undefined;
      if (arnBucket && !bucket) throw new Error(`No bucket named "${arnBucket}" is in ${values.config}; run \`cloudgear plan\` to see the names`);
      if (bucket) {
        const existing = state.entries[stateKey(bucket)];
        if (existing && !existing.imported) {
          throw new Error(`${bucket.type} ${first} is already managed by cloudgear; destroy it before importing another`);
        }
        if (values.arn && second) throw new Error("Give the bucket's ARN with --arn or as the second argument, not both");
        if (third) throw new Error("Usage: cloudgear import <bucket> [physical-id | arn]");
        if (first && arnType && arnType !== "@aws.S3") throw new Error(`${values.arn} is not a bucket ARN, but "${first}" is a bucket`);
        const given = values.arn ?? second;
        const physical = given?.startsWith("arn:") ? bucketOfArn(given) : (given ?? bucket.physical_name);
        state.entries[stateKey(bucket)] = {
          kind: "resource",
          type: bucket.type,
          name: bucket.name,
          physical_name: physical,
          imported: true,
          spec: { physical_name: physical },
          outputs: {},
        };
        saveState(statePath, state);
        console.log(`cloudgear: imported ${bucket.type} ${bucket.name} as "${physical}"`);
        return;
      }

      const typed = first?.startsWith("@") ? first : undefined;
      const name = typed ? second : first;
      if (typed && arnType && typed !== arnType) throw new Error(`${values.arn} is a ${arnType} ARN, not a ${typed} one`);
      if (values.all && first) throw new Error("cloudgear import --all takes no name");
      if (values.all && values.arn) throw new Error("--arn names one thing; it cannot be used with --all");
      if (typed && !name) throw new Error(`Usage: cloudgear import ${typed} <name>`);
      if (!values.all && (typed ? third : second)) throw new Error("A physical id can only be given for a bucket from the config's resources; other things are found by name");
      const planned = plan(config, state);
      if (values.arn && !first) {
        const deployers = await drivers(planned.filter((a) => a.type === arnType), config, configPath, values.region, deployTags(config, configPath, values));
        const found = await adoptByArn(planned, state, deployers, arnType!, values.arn);
        saveState(statePath, state);
        for (const item of found.adopted) console.log(`cloudgear: imported ${item}`);
        for (const note of found.notes) console.warn(`warning: ${note}`);
        if (!found.adopted.length) throw new Error(`No ${arnType} in ${values.config} fits ${values.arn}${found.failed.length ? `:\n  ${found.failed.join("\n  ")}` : ""}`);
        console.log("cloudgear: run `cloudgear plan`; imported things show as updates until `cloudgear apply` brings them in line with the config");
        return;
      }
      const wantedType = typed ?? arnType;
      const select = (action: PlannedAction) => values.all || (action.name === name && (!wantedType || action.type === wantedType));
      const chosen = planned.filter(select);
      if (!values.all) {
        if (!chosen.length) throw new Error(`Nothing named "${name}"${wantedType ? ` of type ${wantedType}` : ""} is in ${values.config}; run \`cloudgear plan\` to see the names`);
        if (chosen.length > 1) throw new Error(`"${name}" names several things (${chosen.map((a) => a.type).join(", ")}); say which: cloudgear import <type> ${name}`);
      }
      const deployers = await drivers(chosen, config, configPath, values.region, deployTags(config, configPath, values));
      const result = await adoptEntries(planned, state, deployers, select, values.arn ? { arn: values.arn } : undefined);
      saveState(statePath, state);
      for (const item of result.adopted) console.log(`cloudgear: imported ${item}`);
      for (const note of result.notes) console.warn(`warning: ${note}`);
      if (values.all) {
        for (const item of result.missing) console.log(`cloudgear: not found in the cloud, apply will create it: ${item}`);
        if (result.skipped.length) console.log(`cloudgear: skipped (already in state, or cannot be imported): ${result.skipped.join(", ")}`);
      }
      if (result.adopted.length) console.log("cloudgear: run `cloudgear plan`; imported things show as updates until `cloudgear apply` brings them in line with the config");
      if (result.failed.length) throw new Error(`These could not be imported (the rest were saved):\n  ${result.failed.join("\n  ")}`);
      if (!values.all && result.missing.length) throw new Error(`${result.missing[0]} was not found in the cloud`);
      if (!values.all && result.skipped.length) throw new Error(`${result.skipped[0]} is already in state or cannot be imported`);
      return;
    }
    default:
      throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

// `arn:aws:s3:::my-bucket` (an object ARN `.../key` is cut back to the bucket).
function bucketOfArn(arn: string): string {
  const parsed = parseArn(arn);
  const name = parsed?.service === "s3" && !parsed.region ? /^([^/]+)/.exec(parsed.resource)?.[1] : undefined;
  if (!name) throw new Error(`"${arn}" is not an S3 bucket ARN${parsed?.resource.startsWith("accesspoint/") ? " (an access point's ARN does not name the bucket)" : ""}`);
  return name;
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
