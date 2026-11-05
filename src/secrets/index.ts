import path from "node:path";
import { createSecretDriver, type SecretDriver } from "@cloudgear/secrets";
import type { CloudgearConfig, SecretRefSpec } from "../config/schema";
import { parseEnvFile } from "./envfile";

export interface SecretGroup {
  // Where the group lives; also how it is told apart from the others.
  key: string;
  service: string;
  region?: string;
  kmsKey?: string;
  path: string;
  // Names some function or DNS declaration reads from this path.
  names: Set<string>;
  // A function reads everything under the path.
  all: boolean;
}

const LIMITS: Record<string, number> = { ssm: 4096, secretsmanager: 65536 };

// The paths the app declares and the names under each, from the config alone.
export function secretGroups(config: CloudgearConfig): SecretGroup[] {
  const groups = new Map<string, SecretGroup>();
  const group = (ref: SecretRefSpec): SecretGroup => {
    const key = `${ref.service}|${ref.region ?? ""}|${ref.kms_key ?? ""}|${ref.path}`;
    const found = groups.get(key) ?? { key, service: ref.service, region: ref.region, kmsKey: ref.kms_key, path: ref.path, names: new Set<string>(), all: false };
    groups.set(key, found);
    return found;
  };
  for (const fn of config.function) {
    for (const binding of fn.secret ?? []) {
      const g = group(binding);
      if (binding.all) g.all = true;
      else g.names.add(binding.name);
    }
  }
  for (const certificate of config.certificate) {
    if (certificate.dns.token) group(certificate.dns.token).names.add(certificate.dns.token.name);
  }
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

export const secretDriverFor = (group: Pick<SecretGroup, "service" | "region" | "kmsKey">, region?: string): Promise<SecretDriver> =>
  createSecretDriver("aws", { service: group.service as never, region: group.region ?? region, kmsKey: group.kmsKey });

// The value of a secret an infrastructure declaration needs: the environment variable of that name first.
export async function readSecretRef(ref: SecretRefSpec, region?: string): Promise<string> {
  const local = process.env[ref.name];
  if (local !== undefined) return local;
  const driver = await secretDriverFor({ service: ref.service, region: ref.region, kmsKey: ref.kms_key }, region);
  const value = await driver.get(`${ref.path}/${ref.name}`);
  if (value === null) throw new Error(`Secret ${ref.path}/${ref.name} was not found; set it with \`cloudgear secrets set\``);
  return value;
}

export interface SetResult {
  written: { path: string; names: string[] }[];
  // Declared, and absent from what was given.
  missing: string[];
  // Given, and declared nowhere.
  undeclared: string[];
  empty: string[];
}

// Writes the declared names found in `values`; with `all`, the rest go under `path` as well.
export async function setSecrets(
  config: CloudgearConfig,
  values: Record<string, string>,
  options: { region?: string; only?: string; all?: boolean; path?: string },
): Promise<SetResult> {
  const groups = secretGroups(config).filter((g) => !options.path || g.path === options.path);
  if (options.path && !groups.length) throw new Error(`No secrets are declared under ${options.path}`);
  const result: SetResult = { written: [], missing: [], undeclared: [], empty: [] };
  const declared = new Set<string>();
  const wanted = new Map<string, SecretGroup[]>();
  for (const g of groups) for (const name of g.names) wanted.set(name, [...(wanted.get(name) ?? []), g]);
  for (const name of wanted.keys()) declared.add(name);

  const writes = new Map<SecretGroup, string[]>();
  const queue = (g: SecretGroup, name: string) => {
    if (values[name] === undefined) return void result.missing.push(`${g.path}/${name}`);
    if (values[name] === "") return void (result.empty.push(name), undefined);
    const limit = LIMITS[g.service]!;
    if (values[name]!.length > limit) throw new Error(`${name} is longer than the ${limit} characters ${g.service} stores`);
    writes.set(g, [...(writes.get(g) ?? []), name]);
  };
  for (const [name, owners] of wanted) {
    if (options.only && name !== options.only) continue;
    for (const g of owners) queue(g, name);
  }
  if (options.only && !wanted.has(options.only)) throw new Error(`No function or DNS declaration reads ${options.only}`);

  if (!options.only) {
    const rest = Object.keys(values).filter((name) => !declared.has(name));
    if (options.all) {
      const target = groups.length === 1 ? groups[0] : groups.find((g) => g.path === options.path);
      if (!target) throw new Error("--all needs --path when the app declares more than one path");
      for (const name of rest) queue(target, name);
    } else {
      result.undeclared.push(...rest);
    }
  }
  for (const [g, names] of writes) {
    const driver = await secretDriverFor(g, options.region);
    for (const name of names) await driver.put(`${g.path}/${name}`, values[name]!);
    result.written.push({ path: g.path, names: names.sort() });
  }
  result.missing = result.missing.filter((m) => !options.only || m.endsWith(`/${options.only}`));
  return result;
}

export interface GroupStatus {
  group: SecretGroup;
  present: string[];
  missing: string[];
  // Stored under the path, declared by no one.
  unused: string[];
}

export async function secretStatus(config: CloudgearConfig, region?: string): Promise<GroupStatus[]> {
  const statuses: GroupStatus[] = [];
  for (const group of secretGroups(config)) {
    const driver = await secretDriverFor(group, region);
    const stored = (await driver.names(group.path)).map((full) => full.slice(group.path.length + 1));
    statuses.push({
      group,
      present: [...group.names].filter((n) => stored.includes(n)).sort(),
      missing: [...group.names].filter((n) => !stored.includes(n)).sort(),
      unused: group.all ? [] : stored.filter((n) => !group.names.has(n)).sort(),
    });
  }
  return statuses;
}

// An env file must stay out of git: tracked files and files git does not ignore are refused.
export function checkEnvFileIgnored(file: string, allowUnignored: boolean): void {
  const cwd = path.dirname(path.resolve(file));
  const name = path.basename(file);
  const tracked = Bun.spawnSync(["git", "ls-files", "--error-unmatch", name], { cwd, stdout: "ignore", stderr: "ignore" });
  if (tracked.exitCode === 0) throw new Error(`${file} is tracked by git; remove it from the repository (git rm --cached) before loading secrets from it`);
  const ignored = Bun.spawnSync(["git", "check-ignore", "-q", name], { cwd, stdout: "ignore", stderr: "ignore" });
  if (ignored.exitCode === 1 && !allowUnignored) {
    throw new Error(`${file} is not ignored by git; add it to .gitignore (for example \`.env*\`), or pass --allow-unignored`);
  }
}

export { parseEnvFile };
