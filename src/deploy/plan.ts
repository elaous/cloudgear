import type { ApiSpec, CdnSpec, CertificateSpec, CloudgearConfig, FunctionSpec, ResourceSpec, SecretBindingSpec, SecretRefSpec } from "../config/schema";
import { createHash } from "node:crypto";
import { toEventBridgeCron } from "@cloudgear/functions";
import { capability, providerOfType, validateConfigOptions } from "../providers";
import { behaviorsFor, conflictingGroups, routeShape } from "../routes";
import { stateKey, type State, type StateEntry } from "./state";

export type Op = "create" | "update" | "replace" | "delete" | "forget" | "noop" | "dry";

export interface DesiredEntry {
  kind: "resource" | "function";
  type: string;
  name: string;
  physical_name: string;
  dry: boolean;
  spec: Record<string, unknown>;
  source: ResourceSpec | FunctionSpec | CertificateSpec | CdnSpec | ApiSpec;
  // State keys that must exist (and be applied) first.
  deps: string[];
  // Re-applied whenever a dependency is created or replaced, because it embeds their outputs.
  refresh?: boolean;
}

export const CLOUDFRONT_REGION = "us-east-1";

export interface CertificateComparable {
  domain: string;
  // An endpoint will own the domain's record, so it must be free.
  for_endpoint: boolean;
  // Empty means the region the app is deployed to.
  region: string;
  dns_provider: string;
  dns_zone: string;
  dns_token?: SecretRefSpec;
  options?: Record<string, string>;
}

export interface ScheduleComparable {
  cron: string;
  // Carried by every run, as a query string.
  query?: Record<string, string>;
  expression: string;
  function: string;
  function_key: string;
}

export interface EventRuleComparable {
  // Physical name of the bus.
  bus: string;
  event_type: string;
  source: string;
  function: string;
  function_key: string;
}

export interface CdnComparable {
  domain: string;
  // The wildcard certificate serving `domain`, when it is not the domain's own.
  certificate_domain?: string;
  dns_provider: string;
  dns_zone: string;
  dns_token?: SecretRefSpec;
  bucket: string;
  bucket_region: string;
  path: string;
  options?: Record<string, string>;
  // Router CDNs have no bucket; one behavior per path.
  behaviors?: { pattern: string; methods: string[]; function: string }[];
  // Set instead of behaviors when a CloudFront Function routes.
  method_routes?: { method: string; path: string; function: string }[];
}

export interface ApiComparable {
  domain: string;
  region: string;
  dns_provider: string;
  dns_zone: string;
  dns_token?: SecretRefSpec;
  routes: { key: string; function: string }[];
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
  scheduled_only?: true;
  invokers: string[];
  permissions: { type: string; physical_name: string; path: string; actions: string[] }[];
  secrets?: SecretBindingSpec[];
}

const FUNCTION_CHANGE_FIELDS: Record<string, (keyof FunctionComparable)[]> = {
  code: ["code"],
  config: ["runtime", "memory_mb", "timeout_s", "env", "reserved_concurrency", "options"],
  permissions: ["permissions", "secrets"],
  auth: ["auth", "scheduled_only"],
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
      ...(fn.route.length ? {} : { scheduled_only: true as const }),
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
      ...(fn.secret?.length ? { secrets: [...fn.secret].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) } : {}),
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

  for (const fn of config.function) {
    const schedules = [...(fn.schedule ?? []).map((cron) => ({ cron })), ...(fn.query_schedule ?? []).map((q) => (Object.keys(q.query).length ? q : { cron: q.cron }))] as { cron: string; query?: Record<string, string> }[];
    for (const { cron, query } of schedules) {
      const queryText = query ? JSON.stringify(Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) : "";
      const id = createHash("sha256").update(queryText ? `${fn.physical_name}\0${cron}\0${queryText}` : `${fn.physical_name}\0${cron}`).digest("hex").slice(0, 8);
      entries.push({
        kind: "resource",
        type: capability(providerOfType(fn.type), "schedule").type,
        name: `${fn.name}@${id}`,
        physical_name: `${fn.physical_name.slice(0, 55)}-${id}`,
        dry: false,
        spec: { cron, ...(query ? { query } : {}), expression: toEventBridgeCron(cron), function: fn.physical_name, function_key: stateKey(fn) } satisfies ScheduleComparable,
        source: fn,
        deps: [stateKey(fn)],
        refresh: true,
      });
    }
  }

  for (const fn of config.function) {
    for (const event of fn.event ?? []) {
      const bus = resources.get(event.bus);
      if (!bus) throw new Error(`cloudgear config references unknown event bus "${event.bus}"`);
      const id = createHash("sha256").update(`${fn.physical_name}\0${physicalOf(event.bus)}\0${event.type}\0${event.source ?? ""}`).digest("hex").slice(0, 8);
      entries.push({
        kind: "resource",
        type: capability(providerOfType(fn.type), "events").rule,
        name: `${fn.name}@${id}`,
        physical_name: `${fn.physical_name.slice(0, 55)}-${id}`,
        dry: false,
        spec: { bus: physicalOf(event.bus), event_type: event.type, source: event.source ?? "", function: fn.physical_name, function_key: stateKey(fn) } satisfies EventRuleComparable,
        source: fn,
        deps: [stateKey(fn), stateKey(bus)],
        refresh: true,
      });
    }
  }

  const certificates = new Map(config.certificate.map((c) => [c.domain, c]));
  const certificateKeyOf = (domain: string, what: "cdn" | "api") => {
    const certificate = certificates.get(domain);
    if (!certificate) throw new Error(`cloudgear config: ${what} needs a certificate for "${domain}"`);
    if (certificate.usage !== what) throw new Error(`cloudgear config: the certificate for "${domain}" must have usage "${what}"`);
    return stateKey({ type: capability(certificate.provider, "cdn").certificate, name: domain });
  };

  for (const certificate of config.certificate) {
    const profile = capability(certificate.provider, "cdn");
    if (certificate.usage === "cdn" && certificate.region && certificate.region !== CLOUDFRONT_REGION) {
      throw new Error(`cloudgear config: the certificate for ${certificate.domain} serves a CDN, so it must be in ${CLOUDFRONT_REGION}`);
    }
    if (certificate.usage === "api" && certificate.region && certificate.region !== (config.region ?? "")) {
      throw new Error(`cloudgear config: the certificate for ${certificate.domain} serves the API, so it must be in the function region`);
    }
    entries.push({
      kind: "resource",
      type: profile.certificate,
      name: certificate.domain,
      physical_name: certificate.domain,
      dry: false,
      spec: {
        domain: certificate.domain,
        for_endpoint: !!certificate.usage,
        region: certificate.region ?? (certificate.usage === "api" ? (config.region ?? "") : CLOUDFRONT_REGION),
        ...optionsSpec(certificate.options),
        dns_provider: certificate.dns.provider,
        dns_zone: certificate.dns.zone,
        ...(certificate.dns.token ? { dns_token: certificate.dns.token } : {}),
      } satisfies CertificateComparable,
      source: certificate,
      deps: [],
    });
  }

  for (const cdn of config.cdn) {
    const certificateDomain = cdn.certificate ?? cdn.domain;
    const certificate = certificates.get(certificateDomain);
    const certificateKey = certificateKeyOf(certificateDomain, "cdn");
    const profile = capability(cdn.provider, "cdn");
    const bucket = resources.get(cdn.bucket);
    if (!bucket) throw new Error(`cloudgear config: cdn bucket "${cdn.bucket}" is not a declared resource`);
    entries.push({
      kind: "resource",
      type: profile.type,
      name: cdn.domain,
      physical_name: cdn.domain,
      dry: false,
      spec: {
        domain: cdn.domain,
        ...(certificateDomain !== cdn.domain ? { certificate_domain: certificateDomain } : {}),
        dns_provider: certificate!.dns.provider,
        dns_zone: certificate!.dns.zone,
        ...(certificate!.dns.token ? { dns_token: certificate!.dns.token } : {}),
        bucket: physicalOf(cdn.bucket),
        bucket_region: (bucket as ResourceSpec).region ?? "",
        path: cdn.path,
        ...optionsSpec(cdn.options),
      } satisfies CdnComparable,
      source: cdn,
      deps: [certificateKey, stateKey(bucket)],
    });
  }

  if (config.api?.via === "cloudfront") {
    const { api } = config;
    const certificateDomain = api.certificate ?? api.domain;
    const certificate = certificates.get(certificateDomain);
    const certificateKey = certificateKeyOf(certificateDomain, "cdn");
    const routed = config.function.filter((fn) => fn.route.length > 0);
    const routes = routed.flatMap((fn) => fn.route.map((route) => ({ method: route.method, path: route.path, function: fn.physical_name })));
    if (!api.method_routing && conflictingGroups(routes).length) {
      throw new Error(`cloudgear config: paths reach different functions, which CloudFront cannot tell apart; set methodRouting on the CDN or use API Gateway`);
    }
    entries.push({
      kind: "resource",
      type: capability(api.provider, "cdn").type,
      name: api.domain,
      physical_name: api.domain,
      dry: false,
      spec: {
        domain: api.domain,
        ...(certificateDomain !== api.domain ? { certificate_domain: certificateDomain } : {}),
        dns_provider: certificate!.dns.provider,
        dns_zone: certificate!.dns.zone,
        ...(certificate!.dns.token ? { dns_token: certificate!.dns.token } : {}),
        bucket: "",
        bucket_region: "",
        path: "",
        ...optionsSpec(api.options),
        ...(api.method_routing
          ? {
              method_routes: routes
                .map((route) => ({ method: route.method, path: routeShape(route.path), function: route.function }))
                .sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`)),
            }
          : { behaviors: behaviorsFor(routes) }),
      } satisfies CdnComparable,
      source: api,
      deps: [certificateKey, ...routed.map((fn) => stateKey(fn))],
      refresh: true,
    });
  } else if (config.api) {
    const { api } = config;
    const certificate = certificates.get(api.domain);
    const certificateKey = certificateKeyOf(api.domain, "api");
    const routed = config.function.filter((fn) => fn.route.length > 0);
    entries.push({
      kind: "resource",
      type: capability(api.provider, "api").type,
      name: api.domain,
      physical_name: api.domain,
      dry: false,
      spec: {
        domain: api.domain,
        region: config.region ?? "",
        dns_provider: certificate!.dns.provider,
        dns_zone: certificate!.dns.zone,
        ...(certificate!.dns.token ? { dns_token: certificate!.dns.token } : {}),
        routes: routed
          .flatMap((fn) => fn.route.map((route) => ({ key: `${route.method} ${route.path}`, function: fn.physical_name })))
          .sort((a, b) => a.key.localeCompare(b.key)),
      } satisfies ApiComparable,
      source: api,
      deps: [certificateKey, ...routed.map((fn) => stateKey(fn))],
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
