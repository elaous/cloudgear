import type { AdoptHint, Drivers } from "./apply";
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
