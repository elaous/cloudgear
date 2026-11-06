import { debug, timed } from "@cloudgear/debug";
import type { EndpointsFile } from "@cloudgear/functions";
import type { CloudgearConfig } from "../config/schema";
import { providerOfType } from "../providers";
import type { DesiredEntry, PlannedAction } from "./plan";
import type { State, StateEntry } from "./state";
import { stateKey } from "./state";

// What a driver can look up while applying: the state of entries applied earlier in this run.
export interface DriverContext {
  entry(key: string): StateEntry | undefined;
}

export interface Driver {
  create(entry: DesiredEntry, context: DriverContext): Promise<Record<string, string>>;
  update(entry: DesiredEntry, current: StateEntry, changes: string[], context: DriverContext): Promise<Record<string, string>>;
  delete(current: StateEntry, context: DriverContext): Promise<void>;
}

export type Drivers = Record<string, Driver>;

// Thrown by a driver whose create failed part-way. `outputs` are what it already made; apply keeps
// them in state (marked incomplete) so the next apply resumes through update() instead of creating again.
export class PartialApplyError extends Error {
  constructor(
    readonly original: unknown,
    readonly outputs: Record<string, string>,
  ) {
    super(original instanceof Error ? original.message : String(original));
  }
}

// Kept alongside the attempted spec so the next plan sees a difference and drivers still know what was set up.
// `previous` is the last fully applied spec, so cleanup still knows what existed before the failed change.
export const incompleteSpec = (spec: Record<string, unknown>, before?: Record<string, unknown>) => {
  const previous = before?.incomplete ? before.previous : before;
  return { ...spec, incomplete: true, ...(previous ? { previous } : {}) };
};

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
  const context: DriverContext = { entry: (key) => state.entries[key] };
  const record = (entry: DesiredEntry, outputs: Record<string, string>, previous?: StateEntry) => {
    state.entries[stateKey(entry)] = {
      kind: entry.kind,
      type: entry.type,
      name: entry.name,
      physical_name: entry.physical_name,
      spec: entry.spec,
      outputs: { ...previous?.outputs, ...outputs },
      deps: entry.deps,
    };
    options.save(state);
    debug("state", `saved ${stateKey(entry)}`, { outputs: Object.keys(state.entries[stateKey(entry)]!.outputs) });
  };

  const create = async (action: PlannedAction) => {
    const desired = action.desired!;
    try {
      record(desired, await driverFor(action.type).create(desired, context));
    } catch (err) {
      if (err instanceof PartialApplyError) {
        state.entries[stateKey(desired)] = {
          kind: desired.kind,
          type: desired.type,
          name: desired.name,
          physical_name: desired.physical_name,
          spec: incompleteSpec(desired.spec),
          outputs: err.outputs,
          deps: desired.deps,
        };
        options.save(state);
        throw err.original;
      }
      throw err;
    }
  };

  const execute = async (action: PlannedAction) => {
    const { desired, current } = action;
    switch (action.op) {
      case "create":
        log(`creating ${action.type} ${action.name}`);
        await create(action);
        break;
      case "update":
        log(`updating ${action.type} ${action.name} (${action.changes.join(", ")})`);
        try {
          record(desired!, await driverFor(action.type).update(desired!, current!, action.changes, context), current);
        } catch (err) {
          if (err instanceof PartialApplyError) {
            state.entries[action.key] = { ...current!, spec: incompleteSpec(desired!.spec, current!.spec), outputs: err.outputs, deps: desired!.deps };
            options.save(state);
            throw err.original;
          }
          throw err;
        }
        break;
      case "replace":
        log(`replacing ${action.type} ${action.name}`);
        await driverFor(action.type).delete(current!, context);
        delete state.entries[action.key];
        options.save(state);
        await create(action);
        break;
      case "delete":
        log(`deleting ${action.type} ${action.name}`);
        await driverFor(action.type).delete(current!, context);
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
  };

  for (const action of actions) {
    if (action.op === "noop" || action.op === "dry") {
      debug("apply", `${action.op} ${action.key}`);
      continue;
    }
    await timed("apply", `${action.op} ${action.key}`, () => execute(action), {
      changes: action.changes,
      deps: action.desired?.deps ?? action.current?.deps,
    });
  }
}

// Providers whose deployers the actions need, from the types being created, changed or removed.
export function providersNeeded(actions: PlannedAction[]): string[] {
  const needing = actions.filter((a) => a.op !== "noop" && a.op !== "dry" && a.op !== "forget");
  return [...new Set(needing.map((a) => providerOfType(a.type)))].sort();
}

// Whether there is anything worth writing to the endpoints file.
export function hasEndpoints(endpoints: EndpointsFile): boolean {
  return Object.keys(endpoints.routes).length > 0 || !!endpoints.cdn || !!endpoints.cdns || !!endpoints.api;
}

export function endpointsFrom(config: CloudgearConfig, state: State): EndpointsFile {
  const routes: Record<string, string> = {};
  for (const fn of config.function) {
    const url = state.entries[stateKey(fn)]?.outputs.url;
    if (!url) continue;
    for (const route of fn.route) routes[`${route.method} ${route.path}`] = url;
  }
  const deployed = config.cdn.flatMap((spec) => {
    const distribution = state.entries[stateKey({ type: "@aws.CloudFront", name: spec.domain })];
    return distribution?.outputs.domain_name ? [{ domain: spec.domain, url: distribution.outputs.url ?? `https://${distribution.outputs.domain_name}`, id: distribution.outputs.id }] : [];
  });
  // `cdn` is the first declared site, when it is deployed; it stays for apps with a single CDN.
  const cdn = deployed.find((site) => site.domain === config.cdn[0]?.domain);
  const viaCloudFront = config.api?.via === "cloudfront";
  const gateway = config.api && state.entries[stateKey({ type: viaCloudFront ? "@aws.CloudFront" : "@aws.ApiGateway", name: config.api.domain })];
  const api = viaCloudFront
    ? gateway?.outputs.domain_name
      ? { domain: config.api!.domain, url: gateway.outputs.url ?? `https://${gateway.outputs.domain_name}`, id: gateway.outputs.id }
      : undefined
    : gateway?.outputs.url
      ? { domain: config.api!.domain, url: gateway.outputs.url, id: gateway.outputs.api_id }
      : undefined;
  // `cdn` is the first declared site; `cdns` lists every deployed site by domain once the app declares several.
  const cdns = config.cdn.length > 1 && deployed.length ? Object.fromEntries(deployed.map((site) => [site.domain, site])) : undefined;
  return { provider: config.provider, routes, auth: config.authenticated, ...(cdn ? { cdn } : {}), ...(cdns ? { cdns } : {}), ...(api ? { api } : {}) };
}
