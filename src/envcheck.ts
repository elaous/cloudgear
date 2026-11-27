import type { CloudgearConfig } from "./config/schema";
import { secretGroups, secretStatus } from "./secrets";

const SKIP = "Pass --skip-env-check to deploy anyway.";

// Checks before deploy that the secrets the functions need are stored.
export async function checkEnvironment(config: CloudgearConfig, region: string | undefined): Promise<void> {
  if (!secretGroups(config).length) return;
  const resolved = config.region || region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  // A DNS token in the deployer's environment needs no storage.
  const fromEnvironment = new Set(config.certificate.flatMap((c) => (c.dns.token && process.env[c.dns.token.name] !== undefined ? [`${c.dns.token.path}/${c.dns.token.name}`] : [])));
  let statuses: Awaited<ReturnType<typeof secretStatus>>;
  try {
    statuses = await secretStatus(config, resolved);
  } catch (err) {
    throw new Error(`Could not check that the secrets are stored (${(err as Error).message}); the deploying identity needs list access to the secret store.\n${SKIP}`);
  }
  const absent = statuses.flatMap((status) => status.missing.map((name) => `${status.group.path}/${name}`)).filter((name) => !fromEnvironment.has(name));
  if (absent.length) throw new Error(`Secrets the functions need are not stored: ${absent.join(", ")}\nStore them with \`cloudgear secrets set\`. ${SKIP}`);
}
