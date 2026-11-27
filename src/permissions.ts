import { desiredGrants, grantId } from "./deploy/gcp/grants";
import type { FunctionComparable, PlannedAction } from "./deploy/plan";
import { providerOfType, providerProfile } from "./providers";

type Permission = FunctionComparable["permissions"][number];
type Secret = NonNullable<FunctionComparable["secrets"]>[number];

// What state holds is the attempted spec after a half-applied apply, and the one before it is kept inside.
function specOf(spec: Record<string, unknown> | undefined): FunctionComparable | undefined {
  if (!spec) return undefined;
  if (spec.incomplete) return spec.previous as FunctionComparable | undefined;
  return spec as unknown as FunctionComparable;
}

// Intents whose provider actions are all in `actions`, using the store's own provider.
export function intentsOf(type: string, actions: readonly string[]): string[] {
  const profile = providerProfile(providerOfType(type)).blobStore;
  if (profile.type !== type) return [];
  return Object.entries(profile.actions)
    .filter(([, wanted]) => wanted.length > 0 && wanted.every((action) => actions.includes(action)))
    .map(([intent]) => intent);
}

interface Line {
  key: string;
  text: string;
  // What makes an entry with the same key different, when it is.
  detail?: string;
}

const permissionKey = (p: Permission) => `${p.type}|${p.physical_name}|${p.path}`;

// Entries with the same store and path grant their actions together.
function mergedPermissions(permissions: readonly Permission[] | undefined): Permission[] {
  const merged = new Map<string, Permission>();
  for (const p of permissions ?? []) {
    const seen = merged.get(permissionKey(p));
    merged.set(permissionKey(p), { ...p, actions: [...new Set([...(seen?.actions ?? []), ...p.actions])].sort() });
  }
  return [...merged.values()].sort((a, b) => (permissionKey(a) < permissionKey(b) ? -1 : 1));
}

function permissionLines(spec: FunctionComparable | undefined): Line[] {
  return mergedPermissions(spec?.permissions).map((p) => {
    const intents = intentsOf(p.type, p.actions);
    return { key: permissionKey(p), text: `${p.type} ${p.physical_name}${p.path ? ` under "${p.path}"` : ""}: ${p.actions.join(", ")}${intents.length ? `  [${intents.join(", ")}]` : ""}`, detail: p.actions.join("\0") };
  });
}

function actionChange(before: Line, after: Line): string | undefined {
  const had = before.detail?.split("\0") ?? [];
  const wanted = after.detail?.split("\0") ?? [];
  const change = [...wanted.filter((a) => !had.includes(a)).map((a) => `+${a}`), ...had.filter((a) => !wanted.includes(a)).map((a) => `-${a}`)];
  return change.join(" ") || undefined;
}

function grantLines(spec: FunctionComparable | undefined, problems: string[]): Line[] {
  try {
    return desiredGrants(spec?.permissions ?? []).map((g) => ({ key: grantId(g), text: `${g.role} on bucket ${g.bucket}${g.path ? ` under "${g.path}"` : ""}` }));
  } catch (err) {
    problems.push((err as Error).message);
    return [];
  }
}

const secretKey = (s: Secret) => `${s.service}|${s.region ?? ""}|${s.path}|${s.all ? "*" : s.name}`;

function secretLines(spec: FunctionComparable | undefined): Line[] {
  const lines: Line[] = [];
  const kms = new Map<string, string>();
  for (const s of [...(spec?.secrets ?? [])].sort((a, b) => (secretKey(a) < secretKey(b) ? -1 : 1))) {
    const region = s.region ? ` in ${s.region}` : "";
    lines.push({
      key: secretKey(s),
      text: `secret ${s.service}${region} ${s.all ? `${s.path}/*` : `${s.path}/${s.name} as ${s.env}`}${s.all && s.service === "secretsmanager" ? " (and secretsmanager:ListSecrets)" : ""}`,
      detail: s.all ? undefined : s.env,
    });
    if (s.kms_key) kms.set(`${s.kms_key}|${s.region ?? ""}`, `kms:Decrypt with ${s.kms_key}`);
  }
  for (const [key, text] of [...kms].sort(([a], [b]) => (a < b ? -1 : 1))) lines.push({ key: `kms|${key}`, text });
  return lines;
}

function tracingLines(spec: FunctionComparable | undefined): Line[] {
  return spec?.options?.tracing === "Active" ? [{ key: "tracing", text: "tracing: xray:PutTraceSegments, xray:PutTelemetryRecords on *" }] : [];
}

// The actions a declared policy document allows, when it can be read.
function policyActions(document: string): string {
  try {
    const parsed = JSON.parse(document) as { Statement?: unknown };
    const statements = Array.isArray(parsed.Statement) ? parsed.Statement : parsed.Statement ? [parsed.Statement] : [];
    const actions = statements.flatMap((s: { Action?: string | string[] }) => (s.Action === undefined ? [] : [s.Action].flat()));
    return actions.length ? `: ${[...new Set(actions)].sort().join(", ")}` : "";
  } catch {
    return "";
  }
}

function policyLines(spec: FunctionComparable | undefined): Line[] {
  return [...(spec?.policies ?? [])]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((p) => ({ key: p.name, text: `policy ${p.name}${policyActions(p.document)}`, detail: p.document }));
}

function diff(had: Line[], wanted: Line[], changed?: (before: Line, after: Line) => string | undefined): string[] {
  const before = new Map(had.map((line) => [line.key, line]));
  const after = new Map(wanted.map((line) => [line.key, line]));
  const out: string[] = [];
  for (const [key, line] of after) {
    const old = before.get(key);
    if (!old) out.push(`    + ${line.text}`);
    else {
      const detail = changed?.(old, line) ?? (old.text !== line.text ? "changed" : undefined);
      out.push(detail ? `    ~ ${line.text} (${detail})` : `      ${line.text}`);
    }
  }
  for (const [key, line] of before) if (!after.has(key)) out.push(`    - ${line.text}`);
  return out;
}

function allLines(spec: FunctionComparable | undefined, problems: string[]) {
  return {
    permissions: permissionLines(spec),
    grants: grantLines(spec, problems),
    secrets: secretLines(spec),
    tracing: tracingLines(spec),
    policies: policyLines(spec),
  };
}

function functionLines(action: PlannedAction): string[] {
  const problems: string[] = [];
  const had = specOf(action.current?.spec);
  const wanted = action.op === "delete" || action.op === "forget" ? undefined : specOf(action.desired?.spec);
  const before = allLines(had, problems);
  const after = allLines(wanted, problems);
  const out: string[] = [];
  for (const group of ["permissions", "grants", "tracing", "secrets", "policies"] as const) {
    if (action.op === "replace") {
      out.push(...before[group].map((line) => `    - ${line.text}`), ...after[group].map((line) => `    + ${line.text}`));
    } else {
      out.push(...diff(before[group], after[group], group === "permissions" ? actionChange : group === "policies" ? (a, b) => (a.detail !== b.detail ? "document changed" : undefined) : (a, b) => (a.detail !== b.detail ? `${a.detail ?? ""} -> ${b.detail ?? ""}` : undefined)));
    }
  }
  return [...out, ...[...new Set(problems)].map((message) => `    ! ${message}`)];
}

const MARKS: Record<string, string> = { create: "+", delete: "-", noop: " ", replace: "-/+" };

// The access each function gets, as a change from what state holds; empty when no function is planned.
export function formatPermissions(actions: PlannedAction[]): string {
  const blocks: string[] = [];
  for (const action of actions) {
    if (action.kind !== "function" || action.op === "dry") continue;
    let lines: string[];
    if (action.op === "forget") lines = ["      imported: removed from state only, nothing is revoked"];
    else if (action.current?.imported) lines = ["      imported: its access is not managed by cloudgear"];
    else {
      lines = functionLines(action);
      if (!lines.length) lines = ["      no permissions"];
    }
    blocks.push([`  ${MARKS[action.op] ?? "~"} ${action.type} ${action.name}`, ...lines].join("\n"));
  }
  if (!blocks.length) return "";
  return ["Permissions (+ granted, - revoked):", ...blocks].join("\n");
}
