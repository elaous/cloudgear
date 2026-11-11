import type { AdoptHint, Drivers } from "./apply";
import { parseArn } from "./aws/arn";
import type { PlannedAction } from "./plan";
import { stateKey, type State } from "./state";

export interface AdoptResult {
  adopted: string[];
  missing: string[];
  skipped: string[];
  failed: string[];
  notes: string[];
  // Files the lookups produced for the user to keep, such as exported policies.
  files: { path: string; content: string }[];
}

// Buckets are recorded, never changed; other resources get managed.
const RECORD_ONLY = new Set(["@aws.S3"]);

const ARN_TYPES = new Set(["@aws.Certificate", "@aws.CloudFront", "@aws.Lambda", "@aws.Schedule", "@aws.S3"]);

const TYPE_OF_SERVICE: Record<string, string> = { acm: "@aws.Certificate", cloudfront: "@aws.CloudFront", lambda: "@aws.Lambda", events: "@aws.Schedule", s3: "@aws.S3" };

export function typeOfArn(arn: string): string {
  const parsed = parseArn(arn);
  if (!parsed) throw new Error(`"${arn}" is not an ARN`);
  const type = TYPE_OF_SERVICE[parsed.service];
  if (!type) throw new Error(`Importing a ${parsed.service} ARN is not supported (certificates, distributions, functions, schedule rules and buckets are)`);
  return type;
}

const label = (action: PlannedAction) => `${action.type} ${action.name}`;

export async function adoptEntries(actions: PlannedAction[], state: State, drivers: Drivers, select: (action: PlannedAction) => boolean, hint?: AdoptHint): Promise<AdoptResult> {
  const result: AdoptResult = { adopted: [], missing: [], skipped: [], failed: [], notes: [], files: [] };
  for (const action of actions) {
    if (!select(action)) continue;
    const entry = action.desired;
    if (entry && state.entries[action.key] && hint?.exportPolicies && drivers[action.type]?.adopt && action.type === "@aws.Lambda") {
      // Already imported: read its policies again, without recording anything.
      try {
        const again = await drivers[action.type]!.adopt!(entry, { entry: (key) => state.entries[key], entries: () => Object.values(state.entries) }, hint);
        for (const note of again?.notes ?? []) result.notes.push(`${label(action)}: ${note}`);
        result.files.push(...(again?.files ?? []));
      } catch (err) {
        result.failed.push(`${label(action)}: ${(err as Error).message}`);
      }
      result.skipped.push(label(action));
      continue;
    }
    if (!entry || action.op === "dry" || state.entries[action.key]) {
      result.skipped.push(label(action));
      continue;
    }
    const driver = drivers[action.type];
    if (!driver?.adopt) {
      result.skipped.push(label(action));
      continue;
    }
    if (hint?.arn && !ARN_TYPES.has(action.type)) {
      result.failed.push(`${label(action)}: importing by ARN is not supported for ${action.type}`);
      continue;
    }
    let found: Awaited<ReturnType<typeof driver.adopt>>;
    try {
      found = await driver.adopt(entry, { entry: (key) => state.entries[key], entries: () => Object.values(state.entries) }, hint);
    } catch (err) {
      result.failed.push(`${label(action)}: ${(err as Error).message}`);
      continue;
    }
    if (!found) {
      result.missing.push(label(action));
      continue;
    }
    for (const note of found.notes ?? []) result.notes.push(`${label(action)}: ${note}`);
    result.files.push(...(found.files ?? []));
    const recordOnly = RECORD_ONLY.has(entry.type);
    state.entries[stateKey(entry)] = {
      kind: entry.kind,
      type: entry.type,
      name: entry.name,
      physical_name: entry.physical_name,
      ...(recordOnly ? { imported: true } : {}),
      spec: recordOnly ? { physical_name: entry.physical_name } : (found.spec ?? {}),
      outputs: found.outputs,
      deps: entry.deps,
    };
    result.adopted.push(label(action));
  }
  return result;
}

// Name from the ARN; only for types told apart by name.
function nameInArn(type: string, arn: string): string | undefined {
  const resource = parseArn(arn)?.resource;
  if (!resource) return undefined;
  if (type === "@aws.Lambda") return resource.split(":")[1];
  if (type === "@aws.Schedule") return resource.startsWith("rule/") ? resource.slice(5).split("/").at(-1) : undefined;
  if (type === "@aws.S3") return resource;
  return undefined;
}

const MAX_REASONS = 5;

// ARN-only lookup: records the one fitting entry, if exactly one.
export async function adoptByArn(actions: PlannedAction[], state: State, drivers: Drivers, type: string, arn: string, exportPolicies = false): Promise<AdoptResult> {
  const total: AdoptResult = { adopted: [], missing: [], skipped: [], failed: [], notes: [], files: [] };
  const typed = actions.filter((action) => action.type === type);
  const candidates = typed.filter((action) => action.op !== "dry" && !state.entries[action.key] && action.desired);
  if (!candidates.length) {
    total.failed.push(typed.length ? `all ${typed.length} ${type} entries in the config are already imported or are not managed here` : `the config has no ${type} entry`);
    return total;
  }
  const named = nameInArn(type, arn);
  const fits: { action: PlannedAction; scratch: State; result: AdoptResult }[] = [];
  const reasons = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (named !== undefined && candidate.desired!.physical_name !== named) continue;
    const scratch: State = { ...state, entries: { ...state.entries } };
    const result = await adoptEntries(actions, scratch, drivers, (action) => action.key === candidate.key, { arn, ...(exportPolicies ? { exportPolicies } : {}) });
    if (result.adopted.length) fits.push({ action: candidate, scratch, result });
    for (const reason of [...result.failed, ...result.missing.map((m) => `${m} was not found in the cloud`)]) {
      const text = reason.replace(/^[^:]*: /, "");
      reasons.set(text, [...(reasons.get(text) ?? []), candidate.name]);
    }
  }
  if (fits.length > 1) {
    total.failed.push(`the ARN fits several entries (${fits.map((f) => f.action.name).join(", ")}); say which: cloudgear import <type> <name> --arn <arn>`);
    return total;
  }
  if (fits.length === 1) {
    const { action, scratch, result } = fits[0]!;
    state.entries[action.key] = scratch.entries[action.key]!;
    return result;
  }
  const lines = [...reasons].map(([text, names]) => `${text} (${names.join(", ")})`);
  total.failed.push(...lines.slice(0, MAX_REASONS), ...(lines.length > MAX_REASONS ? [`... and ${lines.length - MAX_REASONS} more`] : []));
  if (!lines.length) total.failed.push(`no ${type} entry is named "${named}" in the config`);
  return total;
}
