import { debug } from "@cloudgear/debug";
import { loadState, saveState, type State } from "./state";

export interface LockRequest {
  command: string;
}

export interface StateStore {
  load(project: string, provider: string): Promise<{ state: State; version?: string }>;
  save(state: State): Promise<void>;
  lock(request: LockRequest): Promise<() => Promise<void>>;
  saveEndpoints(json: string | undefined): Promise<void>;
  describe(): string;
}

export class LocalStateStore implements StateStore {
  constructor(readonly file: string) {}

  async load(project: string, provider: string) {
    return { state: loadState(this.file, project, provider) };
  }

  async save(state: State) {
    saveState(this.file, state);
  }

  async lock() {
    return async () => {};
  }

  async saveEndpoints() {}

  describe() {
    return this.file;
  }
}

export interface StateStoreOptions {
  url?: string;
  localFile: string;
}

export function stateLocation(flag: string | undefined, env: string | undefined = process.env.CLOUDGEAR_STATE): string | undefined {
  return flag || env || undefined;
}

export async function createStateStore(options: StateStoreOptions): Promise<StateStore> {
  if (!options.url) return new LocalStateStore(options.localFile);
  const { S3StateStore, parseS3Location } = await import("./state-s3");
  const location = parseS3Location(options.url);
  debug("state", "remote state", { bucket: location.bucket, prefix: location.prefix, region: location.region });
  return new S3StateStore(location, { cachePath: options.localFile });
}

// Releases on SIGINT/SIGTERM too, best effort.
export async function holdLock(store: StateStore, request: LockRequest): Promise<() => Promise<void>> {
  const release = await store.lock(request);
  if (store instanceof LocalStateStore) return release;
  let released: Promise<void> | undefined;
  const releaseOnce = () => {
    released ??= release();
    return released;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    releaseOnce()
      .catch(() => {})
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  return async () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    await releaseOnce();
  };
}
