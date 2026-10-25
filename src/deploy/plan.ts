import type { CdnSpec, CertificateSpec, CloudgearConfig, FunctionSpec, ResourceSpec } from "../config/schema";
import { providerProfile, validateConfigOptions } from "../providers";
import { stateKey, type State, type StateEntry } from "./state";

export type Op = "create" | "update" | "replace" | "delete" | "forget" | "noop" | "dry";

export interface DesiredEntry {
  kind: "resource" | "function";
  type: string;
  name: string;
  physical_name: string;
  dry: boolean;
  spec: Record<string, unknown>;
  source: ResourceSpec | FunctionSpec | CertificateSpec | CdnSpec;
  // State keys that must exist (and be applied) first.
  deps: string[];
  // Re-applied whenever a dependency is created or replaced, because it embeds their outputs.
  refresh?: boolean;
}

export interface CertificateComparable {
  domain: string;
  // The certificate is for a CDN that will own the domain's record, so that record must be free.
  for_cdn: boolean;
  dns_provider: string;
  dns_zone: string;
  options?: Record<string, string>;
}

export interface CdnComparable {
  domain: string;
  dns_provider: string;
  dns_zone: string;
  bucket: string;
  bucket_region: string;
  path: string;
  options?: Record<string, string>;
  // Functions served by the CDN; their URLs are read from state when applying.
  behaviors: { path_pattern: string; function: string; methods: string[] }[];
}

export interface PlannedAction {
  op: Op;
  key: string;
  kind: "resource" | "function";
  type: string;
  name: string;
  changes: string[];
  desired?: DesiredEntry;
  current?: StateEntry;
}

export interface FunctionComparable {
  physical_name: string;
  runtime: string;
  memory_mb: number;
  timeout_s: number;
  code: string;
  env: Record<string, string>;
  reserved_concurrency: number;
  options?: Record<string, string>;
  auth: "iam" | "none";
  invokers: string[];
  permissions: { type: string; physical_name: string; path: string; actions: string[] }[];
}

const FUNCTION_CHANGE_FIELDS: Record<string, (keyof FunctionComparable)[]> = {
  code: ["code"],
  config: ["runtime", "memory_mb", "timeout_s", "env", "reserved_concurrency", "options"],
  permissions: ["permissions"],
  auth: ["auth"],
  invokers: ["invokers"],
};

// Empty options omitted so older state still matches.
function optionsSpec(options?: Record<string, string>): { options?: Record<string, string> } {
  return options && Object.keys(options).length ? { options } : {};
}

export function desiredEntries(config: CloudgearConfig, state: State): DesiredEntry[] {
  validateConfigOptions(config);
  const resources = new Map(config.resource.map((r) => [r.name, r]));
  const physicalOf = (name: string) => {
    const resource = resources.get(name);
    if (!resource) throw new Error(`cloudgear config references unknown resource "${name}"`);
    return state.entries[stateKey(resource)]?.imported
      ? state.entries[stateKey(resource)]!.physical_name
      : resource.physical_name;
  };

  const entries: DesiredEntry[] = config.resource.map((r) => ({
    kind: "resource",
    type: r.type,
    name: r.name,
    physical_name: physicalOf(r.name),
    dry: r.dry,
    spec: { physical_name: physicalOf(r.name), region: r.region ?? "", ...optionsSpec(r.options) },
    source: r,
    deps: [],
  }));

  for (const fn of config.function) {
    const spec: FunctionComparable = {
      physical_name: fn.physical_name,
      runtime: fn.runtime,
      memory_mb: fn.memory_mb,
      timeout_s: fn.timeout_s,
      code: fn.bundle.sha256,
      reserved_concurrency: fn.reserved_concurrency,
      ...optionsSpec(fn.options),
      auth: config.authenticated,
      invokers: config.authenticated === "iam" ? [...config.invoker].sort() : [],
      env: Object.fromEntries(
        fn.env.map((e) => [e.key, e.value_from !== undefined ? physicalOf(e.value_from) : (e.value ?? "")]),
      ),
      permissions: fn.permission.map((p) => ({
        type: resources.get(p.resource)?.type ?? "",
        physical_name: physicalOf(p.resource),
        path: p.path,
        actions: [...p.action].sort(),
      })),
    };
    entries.push({
      kind: "function",
      type: fn.type,
      name: fn.name,
      physical_name: fn.physical_name,
      dry: false,
      spec: spec as unknown as Record<string, unknown>,
      source: fn,
      deps: [...new Set(fn.permission.map((p) => p.resource))].flatMap((name) => {
        const resource = resources.get(name);
        return resource ? [stateKey(resource)] : [];
      }),
    });
  }

  if (config.certificate) {
    if (!config.dns) throw new Error("cloudgear config: certificate needs dns");
    const profile = providerProfile(config.provider).cdn;
    entries.push({
      kind: "resource",
      type: profile.certificate,
      name: config.certificate.domain,
      physical_name: config.certificate.domain,
      dry: false,
      spec: {
        domain: config.certificate.domain,
        for_cdn: !!config.cdn,
        ...optionsSpec(config.certificate.options),
        dns_provider: config.dns.provider,
        dns_zone: config.dns.zone,
      } satisfies CertificateComparable,
      source: config.certificate,
      deps: [],
    });
  }

  if (config.cdn) {
    const { cdn, dns } = config;
    if (!dns || !config.certificate) throw new Error("cloudgear config: cdn needs dns and certificate");
    const profile = providerProfile(cdn.provider).cdn;
    const bucket = resources.get(cdn.bucket);
    if (!bucket) throw new Error(`cloudgear config: cdn bucket "${cdn.bucket}" is not a declared resource`);
    const functions = new Map(config.function.map((fn) => [fn.name, fn]));
    const certificateKey = stateKey({ type: profile.certificate, name: config.certificate.domain });
    entries.push({
      kind: "resource",
      type: profile.type,
      name: cdn.domain,
      physical_name: cdn.domain,
      dry: false,
      spec: {
        domain: cdn.domain,
        dns_provider: dns.provider,
        dns_zone: dns.zone,
        bucket: physicalOf(cdn.bucket),
        bucket_region: (bucket as ResourceSpec).region ?? "",
        path: cdn.path,
        ...optionsSpec(cdn.options),
        behaviors: cdn.behavior.map((b) => ({
          path_pattern: b.path_pattern,
          function: functions.get(b.function)?.physical_name ?? b.function,
          methods: [...b.method].sort(),
        })),
      } satisfies CdnComparable,
      source: cdn,
      deps: [
        certificateKey,
        stateKey(bucket),
        ...cdn.behavior.flatMap((b) => {
          const fn = functions.get(b.function);
          return fn ? [stateKey(fn)] : [];
        }),
      ],
      refresh: true,
    });
  }
  return entries;
}

// Stable topological order: dependencies first, ties keep their original order.
function orderByDependencies<T extends { key: string; deps: string[] }>(items: T[]): T[] {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const ordered: T[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (item: T) => {
    if (state.get(item.key) === "done") return;
    if (state.get(item.key) === "visiting") throw new Error(`Dependency cycle through ${item.key}`);
    state.set(item.key, "visiting");
    for (const dep of item.deps) {
      const target = byKey.get(dep);
      if (target) visit(target);
    }
    state.set(item.key, "done");
    ordered.push(item);
  };
  items.forEach(visit);
  return ordered;
}

export function plan(config: CloudgearConfig, state: State): PlannedAction[] {
  const desired = orderByDependencies(desiredEntries(config, state).map((entry) => ({ ...entry, key: stateKey(entry) })));
  const desiredKeys = new Set(desired.map((entry) => entry.key));
  const actions: PlannedAction[] = [];
  const churned = new Set<string>();

  for (const entry of desired) {
    const key = entry.key;
    const current = state.entries[key];
    const base = { key, kind: entry.kind, type: entry.type, name: entry.name, desired: entry, current };
    if (entry.dry) {
      actions.push({ ...base, op: "dry", changes: [] });
    } else if (!current) {
      actions.push({ ...base, op: "create", changes: [] });
    } else if (current.imported) {
      actions.push({ ...base, op: "noop", changes: [] });
    } else if (current.physical_name !== entry.physical_name) {
      actions.push({ ...base, op: "replace", changes: ["physical_name"] });
    } else {
      const changes = entry.kind === "function" ? functionChanges(current.spec, entry.spec) : specChanged(current.spec, entry.spec) ? ["spec"] : [];
      if (!changes.length && entry.refresh && entry.deps.some((dep) => churned.has(dep))) changes.push("dependencies");
      actions.push({ ...base, op: changes.length ? "update" : "noop", changes });
    }
    const last = actions[actions.length - 1]!;
    if (last.op === "create" || last.op === "replace") churned.add(key);
  }

  const removed = Object.entries(state.entries)
    .filter(([key]) => !desiredKeys.has(key))
    .map(([key, current]) => ({ key, current }));
  for (const { key, current } of orderForDeletion(removed)) {
    actions.push({
      op: current.imported ? "forget" : "delete",
      key,
      kind: current.kind,
      type: current.type,
      name: current.name,
      changes: [],
      current,
    });
  }
  return actions;
}

// Dependents go before what they depend on; entries without recorded deps keep functions before resources.
function orderForDeletion<T extends { key: string; current: StateEntry }>(items: T[]): T[] {
  const removing = new Set(items.map((item) => item.key));
  const remaining = new Set(items.map((item) => item.key));
  const byKey = new Map(items.map((item) => [item.key, item]));
  const dependsOn = (item: T, key: string) => (item.current.deps ?? []).includes(key);
  const ordered: T[] = [];
  while (remaining.size) {
    const ready = [...remaining]
      .map((key) => byKey.get(key)!)
      .filter((item) => ![...remaining].some((other) => other !== item.key && dependsOn(byKey.get(other)!, item.key)))
      .sort((a, b) => (a.current.kind === b.current.kind ? 0 : a.current.kind === "function" ? -1 : 1));
    const next = ready[0];
    if (!next) throw new Error(`Dependency cycle among ${[...remaining].filter((key) => removing.has(key)).join(", ")}`);
    ordered.push(next);
    remaining.delete(next.key);
  }
  return ordered;
}

function functionChanges(current: Record<string, unknown>, desired: Record<string, unknown>): string[] {
  return Object.entries(FUNCTION_CHANGE_FIELDS)
    .filter(([, fields]) => fields.some((f) => specChanged(current[f], desired[f])))
    .map(([change]) => change);
}

function specChanged(a: unknown, b: unknown): boolean {
  return canonical(a) !== canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

const SYMBOLS: Record<Op, string> = {
  create: "+",
  update: "~",
  replace: "-/+",
  delete: "-",
  forget: "~",
  noop: " ",
  dry: "=",
};

export function formatPlan(actions: PlannedAction[]): string {
  const lines = actions.map((a) => {
    const detail =
      a.op === "dry"
        ? " (dry: assumed to exist, not managed)"
        : a.op === "forget"
          ? " (imported: removed from state only)"
          : a.changes.length
            ? ` (${a.changes.join(", ")})`
            : "";
    return `  ${SYMBOLS[a.op].padStart(3)} ${a.type} ${a.name}${detail}`;
  });
  const count = (op: Op) => actions.filter((a) => a.op === op).length;
  lines.push(
    "",
    `Plan: ${count("create")} to create, ${count("update")} to update, ${count("replace")} to replace, ${count("delete")} to delete, ${count("forget")} to forget.`,
  );
  return lines.join("\n");
}

export function hasChanges(actions: PlannedAction[]): boolean {
  return actions.some((a) => a.op !== "noop" && a.op !== "dry");
}
