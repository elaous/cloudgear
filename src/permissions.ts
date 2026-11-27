import { desiredGrants, grantId } from "./deploy/gcp/grants";
import type { FunctionComparable, PlannedAction } from "./deploy/plan";
import { providerOfType, providerProfile } from "./providers";

type Permission = FunctionComparable["permissions"][number];
type Secret = NonNullable<FunctionComparable["secrets"]>[number];

const specOf = (spec: Record<string, unknown> | undefined): FunctionComparable | undefined => spec as unknown as FunctionComparable | undefined;

// Intents whose provider actions are all in `actions`, using the store's own provider.
export function intentsOf(type: string, actions: readonly string[]): string[] {
  const profile = providerProfile(providerOfType(type)).blobStore;
  if (profile.type !== type) return [];
  return Object.entries(profile.actions)
    .filter(([, wanted]) => wanted.length > 0 && wanted.every((action) => actions.includes(action)))
    .map(([intent]) => intent);
}

const permissionKey = (p: Permission) => `${p.type}|${p.physical_name}|${p.path}`;
const secretKey = (s: Secret) => `${s.service}|${s.region ?? ""}|${s.path}|${s.all ? "*" : `${s.name}>${s.env}`}`;

const where = (p: Permission) => `${p.type} ${p.physical_name}${p.path ? ` under "${p.path}"` : ""}`;

function diffLines<T>(had: readonly T[], wanted: readonly T[], key: (item: T) => string, line: (item: T) => string, changed?: (before: T, after: T) => string | undefined): string[] {
  const before = new Map(had.map((item) => [key(item), item]));
  const after = new Map(wanted.map((item) => [key(item), item]));
  const lines: string[] = [];
  for (const [k, item] of after) {
    const old = before.get(k);
    if (!old) lines.push(`    + ${line(item)}`);
    else {
      const detail = changed?.(old, item);
      lines.push(detail ? `    ~ ${line(item)} (${detail})` : `      ${line(item)}`);
    }
  }
  for (const [k, item] of before) if (!after.has(k)) lines.push(`    - ${line(item)}`);
  return lines;
}

const sorted = <T>(items: readonly T[] | undefined, key: (item: T) => string): T[] => [...(items ?? [])].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

function functionLines(action: PlannedAction): string[] {
  const wanted = action.op === "delete" || action.op === "forget" ? undefined : specOf(action.desired?.spec);
  const had = specOf(action.current?.spec);
  const permissions = diffLines(
    sorted(had?.permissions, permissionKey),
    sorted(wanted?.permissions, permissionKey),
    permissionKey,
    (p) => `${where(p)}: ${[...p.actions].sort().join(", ")}${intentsOf(p.type, p.actions).length ? `  [${intentsOf(p.type, p.actions).join(", ")}]` : ""}`,
    (before, after) => {
      const added = after.actions.filter((a) => !before.actions.includes(a)).map((a) => `+${a}`);
      const removed = before.actions.filter((a) => !after.actions.includes(a)).map((a) => `-${a}`);
      return [...added, ...removed].join(" ") || undefined;
    },
  );
  const grants = diffLines(
    desiredGrants(had?.permissions ?? []),
    desiredGrants(wanted?.permissions ?? []),
    grantId,
    (g) => `${g.role} on bucket ${g.bucket}${g.path ? ` under "${g.path}"` : ""}`,
  );
  const secrets = diffLines(
    sorted(had?.secrets, secretKey),
    sorted(wanted?.secrets, secretKey),
    secretKey,
    (s) => `secret ${s.service} ${s.all ? `${s.path}/*` : `${s.path}/${s.name} as ${s.env}`}`,
  );
  const declared = diffLines(
    sorted(had?.policies, (p) => p.name),
    sorted(wanted?.policies, (p) => p.name),
    (p) => p.name,
    (p) => `policy ${p.name}`,
    (before, after) => (before.document !== after.document ? "document changed" : undefined),
  );
  return [...permissions, ...grants, ...secrets, ...declared];
}

// The access each function gets, as a change from what state holds; empty when no function is planned.
export function formatPermissions(actions: PlannedAction[]): string {
  const blocks: string[] = [];
  for (const action of actions) {
    if (action.kind !== "function" || action.op === "dry") continue;
    const lines = functionLines(action);
    const marker = action.op === "create" ? "+" : action.op === "delete" ? "-" : action.op === "noop" ? " " : "~";
    blocks.push([`  ${marker} ${action.type} ${action.name}`, ...(lines.length ? lines : ["      no permissions"])].join("\n"));
  }
  if (!blocks.length) return "";
  return ["Permissions (+ granted, - revoked):", ...blocks].join("\n");
}
