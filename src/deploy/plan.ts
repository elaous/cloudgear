import type { CloudgearConfig, FunctionSpec, ResourceSpec } from "../config/schema";
import { stateKey, type State, type StateEntry } from "./state";

export type Op = "create" | "update" | "replace" | "delete" | "forget" | "noop" | "dry";

export interface DesiredEntry {
  kind: "resource" | "function";
  type: string;
  name: string;
  physical_name: string;
  dry: boolean;
  spec: Record<string, unknown>;
  source: ResourceSpec | FunctionSpec;
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
  auth: "iam" | "none";
  invokers: string[];
  permissions: { type: string; physical_name: string; actions: string[] }[];
}

const FUNCTION_CHANGE_FIELDS: Record<string, (keyof FunctionComparable)[]> = {
  code: ["code"],
  config: ["runtime", "memory_mb", "timeout_s", "env", "reserved_concurrency"],
  permissions: ["permissions"],
  auth: ["auth"],
  invokers: ["invokers"],
};

export function desiredEntries(config: CloudgearConfig, state: State): DesiredEntry[] {
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
    spec: { physical_name: physicalOf(r.name) },
    source: r,
  }));

  for (const fn of config.function) {
    const spec: FunctionComparable = {
      physical_name: fn.physical_name,
      runtime: fn.runtime,
      memory_mb: fn.memory_mb,
      timeout_s: fn.timeout_s,
      code: fn.bundle.sha256,
      reserved_concurrency: fn.reserved_concurrency,
      auth: config.authenticated,
      invokers: config.authenticated === "iam" ? [...config.invoker].sort() : [],
      env: Object.fromEntries(
        fn.env.map((e) => [e.key, e.value_from !== undefined ? physicalOf(e.value_from) : (e.value ?? "")]),
      ),
      permissions: fn.permission.map((p) => ({
        type: resources.get(p.resource)?.type ?? "",
        physical_name: physicalOf(p.resource),
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
    });
  }
  return entries;
}

export function plan(config: CloudgearConfig, state: State): PlannedAction[] {
  const desired = desiredEntries(config, state);
  const desiredKeys = new Set(desired.map(stateKey));
  const actions: PlannedAction[] = [];

  for (const entry of desired) {
    const key = stateKey(entry);
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
      actions.push({ ...base, op: changes.length ? "update" : "noop", changes });
    }
  }

  const removed = Object.entries(state.entries)
    .filter(([key]) => !desiredKeys.has(key))
    .sort(([, a], [, b]) => (a.kind === b.kind ? 0 : a.kind === "function" ? -1 : 1));
  for (const [key, current] of removed) {
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
