import type { AdoptHint, Drivers } from "./apply";
import { parseArn } from "./aws/arn";
import type { PlannedAction } from "./plan";
import { stateKey, type State } from "./state";

export interface AdoptResult {
  adopted: string[];
  // Planned, but nothing by that name exists in the cloud.
  missing: string[];
  // Already in state, or a driver that cannot look things up.
  skipped: string[];
  // Lookups that failed, with why; the others are still recorded.
  failed: string[];
  // What `apply` will change on what was found.
  notes: string[];
}

// Buckets are only ever recorded, never changed (as `cloudgear import <bucket>` always did); everything else
// is managed from here on, so the next `apply` brings it in line with the config.
const RECORD_ONLY = new Set(["@aws.S3"]);

// The drivers that can be told which one by its ARN.
const ARN_TYPES = new Set(["@aws.Certificate", "@aws.CloudFront", "@aws.Lambda", "@aws.Schedule", "@aws.S3"]);

// The entry type an ARN's service stands for.
const TYPE_OF_SERVICE: Record<string, string> = { acm: "@aws.Certificate", cloudfront: "@aws.CloudFront", lambda: "@aws.Lambda", events: "@aws.Schedule", s3: "@aws.S3" };

export function typeOfArn(arn: string): string {
  const parsed = parseArn(arn);
  if (!parsed) throw new Error(`"${arn}" is not an ARN`);
  const type = TYPE_OF_SERVICE[parsed.service];
  if (!type) throw new Error(`Importing a ${parsed.service} ARN is not supported (certificates, distributions, functions, schedule rules and buckets are)`);
  return type;
}

const label = (action: PlannedAction) => `${action.type} ${action.name}`;

// Looks each planned entry that is not in state yet up in the cloud and records it, in dependency order.
export async function adoptEntries(actions: PlannedAction[], state: State, drivers: Drivers, select: (action: PlannedAction) => boolean, hint?: AdoptHint): Promise<AdoptResult> {
  const result: AdoptResult = { adopted: [], missing: [], skipped: [], failed: [], notes: [] };
  for (const action of actions) {
    if (!select(action)) continue;
    const entry = action.desired;
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
    let found;
    try {
      found = await driver.adopt(entry, { entry: (key) => state.entries[key] }, hint);
    } catch (err) {
      result.failed.push(`${label(action)}: ${(err as Error).message}`);
      continue;
    }
    if (!found) {
      result.missing.push(label(action));
      continue;
    }
    for (const note of found.notes ?? []) result.notes.push(`${label(action)}: ${note}`);
    const recordOnly = RECORD_ONLY.has(entry.type);
    state.entries[stateKey(entry)] = {
      kind: entry.kind,
      type: entry.type,
      name: entry.name,
      physical_name: entry.physical_name,
      ...(recordOnly ? { imported: true } : {}),
      // The settings read from the cloud differ from the config, so the next plan shows an update that converges it.
      spec: recordOnly ? { physical_name: entry.physical_name } : (found.spec ?? {}),
      outputs: found.outputs,
      deps: entry.deps,
    };
    result.adopted.push(label(action));
  }
  return result;
}

// With only an ARN: tries each planned entry of its type that is not in state, and keeps the one the ARN fits
// (a certificate whose domain is the entry's, a distribution that answers to its domain, a function of its name).
export async function adoptByArn(actions: PlannedAction[], state: State, drivers: Drivers, type: string, arn: string): Promise<AdoptResult> {
  const total: AdoptResult = { adopted: [], missing: [], skipped: [], failed: [], notes: [] };
  const candidates = actions.filter((action) => action.type === type && action.op !== "dry" && !state.entries[action.key] && action.desired);
  for (const candidate of candidates) {
    const result = await adoptEntries(actions, state, drivers, (action) => action.key === candidate.key, { arn });
    if (result.adopted.length) return result;
    for (const key of ["missing", "skipped", "failed", "notes"] as const) total[key].push(...result[key]);
  }
  return total;
}
