import fs from "node:fs";
import path from "node:path";
import type { CloudgearConfig } from "./config/schema";
import { configHash, envReportPath, formatMissingEnv, missingEnv, readEnvReport, type EnvReport } from "./envreport";
import { secretGroups, secretStatus } from "./secrets";

const SKIP = "Pass --skip-env-check to deploy anyway.";

function currentReport(config: CloudgearConfig, configPath: string): EnvReport | undefined {
  const report = readEnvReport(envReportPath(configPath));
  if (report && report.config !== configHash(fs.readFileSync(configPath, "utf8"))) {
    throw new Error(`${path.relative(process.cwd(), envReportPath(configPath))} was made for another config; re-run \`cloudgear generate\` (and commit both files together)`);
  }
  void config;
  return report;
}

// What `plan` says about the environment, without deciding anything.
export function envWarnings(config: CloudgearConfig, configPath: string): string | undefined {
  try {
    const report = currentReport(config, configPath);
    const missing = report ? missingEnv(report) : [];
    return missing.length ? `${formatMissingEnv(missing)}\n         \`cloudgear apply\` will refuse to deploy until they are provided.` : undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

// The code's environment variables must be provided, and the secrets behind them stored, before anything is deployed.
export async function checkEnvironment(config: CloudgearConfig, configPath: string, region: string | undefined, warn: (message: string) => void = console.warn): Promise<void> {
  const reportFile = envReportPath(configPath);
  const report = currentReport(config, configPath);
  if (!report) throw new Error(`${path.relative(process.cwd(), reportFile)} not found; run \`cloudgear generate\` first, or pass --skip-env-check`);
  const missing = missingEnv(report);
  if (missing.length) throw new Error(`${formatMissingEnv(missing)}\n${SKIP}`);
  for (const [name, fn] of Object.entries(report.functions)) {
    if (fn.dynamic.length) warn(`warning: ${name} reads the environment in ways that cannot be checked (${fn.dynamic.join(", ")})`);
  }
  if (!secretGroups(config).length) return;
  const resolved = config.region || region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  // A DNS token set in the deployer's own environment is used from there, so it need not be stored.
  const fromEnvironment = new Set(config.certificate.flatMap((c) => (c.dns.token && process.env[c.dns.token.name] !== undefined ? [`${c.dns.token.path}/${c.dns.token.name}`] : [])));
  let statuses;
  try {
    statuses = await secretStatus(config, resolved);
  } catch (err) {
    throw new Error(`Could not check that the secrets are stored (${(err as Error).message}); the deploying identity needs list access to the secret store.\n${SKIP}`);
  }
  const absent = statuses.flatMap((status) => status.missing.map((name) => `${status.group.path}/${name}`)).filter((name) => !fromEnvironment.has(name));
  if (absent.length) throw new Error(`Secrets the functions need are not stored: ${absent.join(", ")}\nStore them with \`cloudgear secrets set\`. ${SKIP}`);
}
