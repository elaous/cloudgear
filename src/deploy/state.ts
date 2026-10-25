import fs from "node:fs";
import path from "node:path";

export interface StateEntry {
  kind: "resource" | "function";
  type: string;
  name: string;
  physical_name: string;
  // Adopted through `cloudgear import`: never deleted, only forgotten.
  imported?: boolean;
  // Comparable spec as last applied; see desiredEntries() in plan.ts.
  spec: Record<string, unknown>;
  outputs: Record<string, string>;
  // State keys this entry needs; deletes run in reverse dependency order.
  deps?: string[];
}

export interface State {
  version: 1;
  project: string;
  provider: string;
  entries: Record<string, StateEntry>;
}

export function stateKey(entry: { type: string; name: string }): string {
  return `${entry.type}.${entry.name}`;
}

export function loadState(file: string, project: string, provider: string): State {
  if (!fs.existsSync(file)) return { version: 1, project, provider, entries: {} };
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as State;
  if (state.version !== 1) throw new Error(`${file}: unsupported state version ${state.version}`);
  if (state.project !== project || state.provider !== provider) {
    throw new Error(
      `${file} belongs to project "${state.project}" (${state.provider}), config is "${project}" (${provider})`,
    );
  }
  return state;
}

export function saveState(file: string, state: State): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
