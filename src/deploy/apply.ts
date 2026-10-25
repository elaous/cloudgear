import type { EndpointsFile } from "@cloudgear/functions";
import type { CloudgearConfig } from "../config/schema";
import type { DesiredEntry, PlannedAction } from "./plan";
import type { State, StateEntry } from "./state";
import { stateKey } from "./state";

export interface Driver {
  create(entry: DesiredEntry): Promise<Record<string, string>>;
  update(entry: DesiredEntry, current: StateEntry, changes: string[]): Promise<Record<string, string>>;
  delete(current: StateEntry): Promise<void>;
}

export type Drivers = Record<string, Driver>;

export interface ApplyOptions {
  save: (state: State) => void;
  log?: (message: string) => void;
}

// Persists state after every action so a failure part-way keeps what succeeded.
export async function apply(actions: PlannedAction[], state: State, drivers: Drivers, options: ApplyOptions): Promise<void> {
  const log = options.log ?? (() => {});
  const driverFor = (type: string) => {
    const driver = drivers[type];
    if (!driver) throw new Error(`No driver for resource type "${type}"`);
    return driver;
  };
  const record = (entry: DesiredEntry, outputs: Record<string, string>, previous?: StateEntry) => {
    state.entries[stateKey(entry)] = {
      kind: entry.kind,
      type: entry.type,
      name: entry.name,
      physical_name: entry.physical_name,
      spec: entry.spec,
      outputs: { ...previous?.outputs, ...outputs },
    };
    options.save(state);
  };

  for (const action of actions) {
    const { desired, current } = action;
    switch (action.op) {
      case "create":
        log(`creating ${action.type} ${action.name}`);
        record(desired!, await driverFor(action.type).create(desired!));
        break;
      case "update":
        log(`updating ${action.type} ${action.name} (${action.changes.join(", ")})`);
        record(desired!, await driverFor(action.type).update(desired!, current!, action.changes), current);
        break;
      case "replace":
        log(`replacing ${action.type} ${action.name}`);
        await driverFor(action.type).delete(current!);
        delete state.entries[action.key];
        options.save(state);
        record(desired!, await driverFor(action.type).create(desired!));
        break;
      case "delete":
        log(`deleting ${action.type} ${action.name}`);
        await driverFor(action.type).delete(current!);
        delete state.entries[action.key];
        options.save(state);
        break;
      case "forget":
        log(`forgetting ${action.type} ${action.name}`);
        delete state.entries[action.key];
        options.save(state);
        break;
      case "noop":
      case "dry":
        break;
    }
  }
}

export function endpointsFrom(config: CloudgearConfig, state: State): EndpointsFile {
  const routes: Record<string, string> = {};
  for (const fn of config.function) {
    const url = state.entries[stateKey(fn)]?.outputs.url;
    if (!url) continue;
    for (const route of fn.route) routes[`${route.method} ${route.path}`] = url;
  }
  return { provider: config.provider, routes, token: state.invoke_token };
}
