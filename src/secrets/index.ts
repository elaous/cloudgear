import path from "node:path";
import { createSecretDriver, type SecretDriver } from "@cloudgear/secrets";
import type { CloudgearConfig, SecretRefSpec } from "../config/schema";
import { parseEnvFile } from "./envfile";

export interface SecretGroup {
  key: string;
  service: string;
  region?: string;
  kmsKey?: string;
  path: string;
  names: Set<string>;
  aliases: Map<string, string>;
  all: boolean;
}

const LIMITS: Record<string, number> = { ssm: 4096, secretsmanager: 65536 };

export function secretGroups(config: CloudgearConfig): SecretGroup[] {
  const groups = new Map<string, SecretGroup>();
  const group = (ref: SecretRefSpec): SecretGroup => {
    const key = `${ref.service}|${ref.region ?? ""}|${ref.kms_key ?? ""}|${ref.path}`;
    const found = groups.get(key) ?? { key, service: ref.service, region: ref.region, kmsKey: ref.kms_key, path: ref.path, names: new Set<string>(), aliases: new Map<string, string>(), all: false };
    groups.set(key, found);
    return found;
  };
  for (const fn of config.function) {
    for (const binding of fn.secret ?? []) {
      const g = group(binding);
      if (binding.all) g.all = true;
      else {
        g.names.add(binding.name);
        if (binding.env && binding.env !== binding.name) g.aliases.set(binding.name, binding.env);
      }
    }
  }
  for (const certificate of config.certificate) {
    if (certificate.dns.token) group(certificate.dns.token).names.add(certificate.dns.token.name);
  }
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

export const secretDriverFor = (group: Pick<SecretGroup, "service" | "region" | "kmsKey">, region?: string): Promise<SecretDriver> =>
  createSecretDriver("aws", { service: group.service as never, region: group.region ?? region, kmsKey: group.kmsKey });

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
  missing: string[];
  undeclared: string[];
  empty: string[];
}

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
  for (const [name, owners] of wanted) {
    declared.add(name);
    for (const g of owners) if (g.aliases.has(name)) declared.add(g.aliases.get(name)!);
  }

  const writes = new Map<SecretGroup, string[]>();
  const queue = (g: SecretGroup, name: string) => {
    const value = values[name] ?? values[g.aliases.get(name) ?? ""];
    if (value === undefined) return void result.missing.push(`${g.path}/${name}`);
    if (value === "") return void result.empty.push(name);
    const limit = LIMITS[g.service]!;
    if (Buffer.byteLength(value) > limit) throw new Error(`${name} is longer than the ${limit} bytes ${g.service} stores`);
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
    for (const name of names) await driver.put(`${g.path}/${name}`, values[name] ?? values[g.aliases.get(name)!]!);
    result.written.push({ path: g.path, names: names.sort() });
  }
  result.missing = result.missing.filter((m) => !options.only || m.endsWith(`/${options.only}`));
  return result;
}

export interface GroupStatus {
  group: SecretGroup;
  present: string[];
  missing: string[];
  unused: string[];
}

export async function secretStatus(config: CloudgearConfig, region?: string): Promise<GroupStatus[]> {
  const statuses: GroupStatus[] = [];
  const groups = secretGroups(config);
  for (const group of groups) {
    const declaredHere = new Set(groups.filter((g) => g.path === group.path).flatMap((g) => [...g.names]));
    const driver = await secretDriverFor(group, region);
    const stored = (await driver.names(group.path)).map((full) => full.slice(group.path.length + 1));
    statuses.push({
      group,
      present: (group.all ? stored : [...group.names].filter((n) => stored.includes(n))).sort(),
      missing: [...group.names].filter((n) => !stored.includes(n)).sort(),
      unused: groups.some((g) => g.path === group.path && g.all) ? [] : stored.filter((n) => !declaredHere.has(n)).sort(),
    });
  }
  return statuses;
}

// Refuses env files that git tracks or does not ignore.
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
