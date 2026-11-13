import fs from "node:fs";
import path from "node:path";

export interface StateEntry {
  kind: "resource" | "function";
  type: string;
  name: string;
  physical_name: string;
  // Adopted through `cloudgear import`: never deleted, only forgotten.
  imported?: boolean;
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

export function parseState(text: string, source: string, project: string, provider: string): State {
  const state = JSON.parse(text) as State;
  if (state.version !== 1) throw new Error(`${source}: unsupported state version ${state.version}`);
  if (state.project !== project || state.provider !== provider) {
    throw new Error(
      `${source} belongs to project "${state.project}" (${state.provider}), config is "${project}" (${provider})`,
    );
  }
  return state;
}

export function loadState(file: string, project: string, provider: string): State {
  if (!fs.existsSync(file)) return { version: 1, project, provider, entries: {} };
  return parseState(fs.readFileSync(file, "utf8"), file, project, provider);
}

export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function serializeState(state: State): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function saveState(file: string, state: State): void {
  writeFileAtomic(file, serializeState(state));
}
