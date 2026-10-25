#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { decodeConfig, type CloudgearConfig } from "./config/schema";
import { apply, endpointsFrom, type Drivers } from "./deploy/apply";
import { awsDrivers } from "./deploy/aws";
import { formatPlan, hasChanges, plan } from "./deploy/plan";
import { loadState, saveState, stateKey } from "./deploy/state";
import { generate } from "./generate";

const USAGE = `Usage: cloudgear <command> [options]

Commands:
  generate <entry.ts>          Analyze the app and write cloudgear.prototxt + function bundles
  plan                         Show what apply would change
  apply [--auto-approve]       Create, update and delete cloud resources to match the config
  import <name> [physical-id]  Adopt an existing resource into state instead of creating it
  destroy [--auto-approve]     Delete every managed resource (imported ones are only forgotten)

Options:
  --config <file>    Config file (default: cloudgear.prototxt)
  --project <name>   Project name used to prefix function names (generate only)
  --region <region>  Cloud region (default: $AWS_REGION / $AWS_DEFAULT_REGION)
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", default: "cloudgear.prototxt" },
      project: { type: "string" },
      region: { type: "string" },
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

  switch (command) {
    case "generate": {
      const entry = args[0];
      if (!entry) throw new Error("Usage: cloudgear generate <entry.ts>");
      const { config, warnings } = await generate({
        entry,
        configPath,
        buildDir: path.join(workDir, "build"),
        project: values.project,
      });
      for (const warning of warnings) console.warn(`warning: ${warning}`);
      console.log(
        `cloudgear: ${config.function.length} function(s), ${config.resource.length} resource(s) -> ${path.relative(process.cwd(), configPath)}`,
      );
      return;
    }
    case "plan": {
      const config = readConfig(configPath);
      const actions = plan(config, loadState(statePath, config.project, config.provider));
      console.log(formatPlan(actions));
      return;
    }
    case "apply":
    case "destroy": {
      const config = readConfig(configPath);
      const state = loadState(statePath, config.project, config.provider);
      const target = command === "destroy" ? { ...config, resource: [], function: [] } : config;
      const actions = plan(target, state);
      console.log(formatPlan(actions));
      if (!hasChanges(actions)) {
        console.log("\nNo changes.");
      } else {
        if (!values["auto-approve"] && !confirm(`\nDo you want to ${command}?`)) {
          console.log("Cancelled.");
          return;
        }
        await apply(actions, state, drivers(config, configPath, values.region), {
          save: (s) => saveState(statePath, s),
          log: (message) => console.log(`cloudgear: ${message}`),
        });
      }
      const endpointsPath = path.join(workDir, "endpoints.json");
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(endpointsPath, JSON.stringify(endpointsFrom(config, state), null, 2) + "\n");
      console.log(`cloudgear: ${command} complete, endpoints -> ${path.relative(process.cwd(), endpointsPath)}`);
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

function readConfig(configPath: string): CloudgearConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`${path.relative(process.cwd(), configPath)} not found; run \`cloudgear generate <entry.ts>\` first`);
  }
  return decodeConfig(fs.readFileSync(configPath, "utf8"));
}

function drivers(config: CloudgearConfig, configPath: string, region: string | undefined): Drivers {
  if (config.provider !== "aws") throw new Error(`Provider "${config.provider}" has no deploy drivers yet`);
  const resolvedRegion = region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!resolvedRegion) throw new Error("Set --region or AWS_REGION to deploy");
  const configDir = path.dirname(configPath);
  return awsDrivers({
    region: resolvedRegion,
    readBundle: (fn) => {
      const file = path.resolve(configDir, fn.bundle.path);
      const data = fs.readFileSync(file);
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(data);
      if (hasher.digest("hex") !== fn.bundle.sha256) {
        throw new Error(`${fn.bundle.path} does not match the config's sha256; re-run \`cloudgear generate\``);
      }
      return new Uint8Array(data);
    },
  });
}

main().catch((err) => {
  console.error(`cloudgear: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
