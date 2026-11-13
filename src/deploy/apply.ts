import { debug, timed } from "@cloudgear/debug";
import type { EndpointsFile } from "@cloudgear/functions";
import type { CloudgearConfig } from "../config/schema";
import { providerOfType } from "../providers";
import type { DesiredEntry, PlannedAction } from "./plan";
import type { State, StateEntry } from "./state";
import { stateKey } from "./state";

export interface DriverContext {
  entry(key: string): StateEntry | undefined;
  // Everything in state now, for a driver that must know what else uses a shared thing.
  entries?(): StateEntry[];
}

export interface Driver {
  create(entry: DesiredEntry, context: DriverContext): Promise<Record<string, string>>;
  update(entry: DesiredEntry, current: StateEntry, changes: string[], context: DriverContext): Promise<Record<string, string>>;
  delete(current: StateEntry, context: DriverContext): Promise<void>;
  // Drivers without this lookup cannot import.
  adopt?(entry: DesiredEntry, context: DriverContext, hint?: AdoptHint): Promise<Adopted | undefined>;
}

export interface AdoptHint {
  arn?: string;
  // Also read the policies of the imported function's role, to be written out as files.
  exportPolicies?: boolean;
}

export interface Adopted {
  // Files to write for the user (paths relative to the directory they chose), such as an exported policy.
  files?: { path: string; content: string }[];
  outputs: Record<string, string>;
  spec?: Record<string, unknown>;
  notes?: string[];
}

export type Drivers = Record<string, Driver>;

// Thrown by create on partial failure; next apply uses update().
export class PartialApplyError extends Error {
  constructor(
    readonly original: unknown,
    readonly outputs: Record<string, string>,
  ) {
    super(original instanceof Error ? original.message : String(original));
  }
}

// Attempted spec; kept so the next plan sees the difference.
export const incompleteSpec = (spec: Record<string, unknown>, before?: Record<string, unknown>) => {
  const previous = before?.incomplete ? before.previous : before;
  return { ...spec, incomplete: true, ...(previous ? { previous } : {}) };
};

export interface ApplyOptions {
  save: (state: State) => void | Promise<void>;
  log?: (message: string) => void;
}

// Saves state after each action; partial failures keep progress.
export async function apply(actions: PlannedAction[], state: State, drivers: Drivers, options: ApplyOptions): Promise<void> {
  const log = options.log ?? (() => {});
  const driverFor = (type: string) => {
    const driver = drivers[type];
    if (!driver) throw new Error(`No driver for resource type "${type}"`);
    return driver;
  };
  const context: DriverContext = { entry: (key) => state.entries[key], entries: () => Object.values(state.entries) };
  const record = async (entry: DesiredEntry, outputs: Record<string, string>, previous?: StateEntry) => {
    state.entries[stateKey(entry)] = {
      kind: entry.kind,
      type: entry.type,
      name: entry.name,
      physical_name: entry.physical_name,
      spec: entry.spec,
      outputs: { ...previous?.outputs, ...outputs },
      deps: entry.deps,
    };
    await options.save(state);
    debug("state", `saved ${stateKey(entry)}`, { outputs: Object.keys(state.entries[stateKey(entry)]!.outputs) });
  };

  const create = async (action: PlannedAction) => {
    const desired = action.desired!;
    try {
      await record(desired, await driverFor(action.type).create(desired, context));
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
        await options.save(state);
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
          await record(desired!, await driverFor(action.type).update(desired!, current!, action.changes, context), current);
        } catch (err) {
          if (err instanceof PartialApplyError) {
            state.entries[action.key] = { ...current!, spec: incompleteSpec(desired!.spec, current!.spec), outputs: err.outputs, deps: desired!.deps };
            await options.save(state);
            throw err.original;
          }
          throw err;
        }
        break;
      case "replace":
        log(`replacing ${action.type} ${action.name}`);
        await driverFor(action.type).delete(current!, context);
        delete state.entries[action.key];
        await options.save(state);
        await create(action);
        break;
      case "delete":
        log(`deleting ${action.type} ${action.name}`);
        await driverFor(action.type).delete(current!, context);
        delete state.entries[action.key];
        await options.save(state);
        break;
      case "forget":
        log(`forgetting ${action.type} ${action.name}`);
        delete state.entries[action.key];
        await options.save(state);
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

export function providersNeeded(actions: PlannedAction[]): string[] {
  const needing = actions.filter((a) => a.op !== "noop" && a.op !== "dry" && a.op !== "forget");
  return [...new Set(needing.map((a) => providerOfType(a.type)))].sort();
}

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
  // First declared site; kept for single-CDN apps.
  const cdn = deployed.find((site) => site.domain === config.cdn[0]?.domain);
  const viaCloudFront = config.api?.via === "cloudfront";
  const gateway = config.api && state.entries[stateKey({ type: viaCloudFront ? "@aws.CloudFront" : "@aws.ApiGateway", name: config.api.domain })];
  const api = viaCloudFront
    ? gateway?.outputs.domain_name
      ? { domain: config.api!.domain, url: gateway.outputs.url ?? `https://${gateway.outputs.domain_name}`, id: gateway.outputs.id, via: "cloudfront" as const }
      : undefined
    : gateway?.outputs.url
      ? { domain: config.api!.domain, url: gateway.outputs.url, id: gateway.outputs.api_id }
      : undefined;
  const cdns = config.cdn.length > 1 && deployed.length ? Object.fromEntries(deployed.map((site) => [site.domain, site])) : undefined;
  return { provider: config.provider, routes, auth: config.authenticated, ...(cdn ? { cdn } : {}), ...(cdns ? { cdns } : {}), ...(api ? { api } : {}) };
}
