import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { debug } from "@cloudgear/debug";
import { loadState, saveState, serializeState, writeFileAtomic, type State } from "./state";

export type Release = (signal?: AbortSignal) => Promise<void>;

export interface LockRequest {
  command: string;
}

export interface StateStore {
  load(project: string, provider: string): Promise<{ state: State; version?: string }>;
  save(state: State): Promise<void>;
  lock(request: LockRequest): Promise<Release>;
  saveEndpoints(json: string | undefined): Promise<void>;
  describe(): string;
  readonly unpushedLocalEntries?: number;
}

export const MARKER_FILE = "state.remote.json";

export interface RemoteMarker {
  location?: string;
  etag?: string;
  sha256?: string;
}

export function readRemoteMarker(directory: string): RemoteMarker | undefined {
  const file = path.join(directory, MARKER_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RemoteMarker;
  } catch {
    return {};
  }
}

export class LocalStateStore implements StateStore {
  constructor(readonly file: string) {}

  private assertNotRemote(): void {
    const directory = path.dirname(this.file);
    const marker = readRemoteMarker(directory);
    if (!marker) return;
    const file = path.join(directory, MARKER_FILE);
    throw new Error(
      marker.location
        ? `this directory uses remote state at ${marker.location}; pass --state ${marker.location} or delete ${file}`
        : `this directory uses remote state, but ${file} cannot be read; pass --state with its location or delete the file`,
    );
  }

  async load(project: string, provider: string) {
    this.assertNotRemote();
    return { state: loadState(this.file, project, provider) };
  }

  async save(state: State) {
    this.assertNotRemote();
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

export function assertNoUnpushedLocalState(store: StateStore, allowEmptyRemote: boolean): void {
  if (!store.unpushedLocalEntries || allowEmptyRemote) return;
  throw new Error(
    `The local state holds ${store.unpushedLocalEntries} entries but ${store.describe()} holds none, so this would plan to create everything again. Run \`cloudgear state push\` to upload the local state, or pass --allow-empty-remote to start from an empty state`,
  );
}

export const UNSAVED_PREFIX = "state.json.unsaved";

export function findUnsavedStates(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.startsWith(`${UNSAVED_PREFIX}.`) && !name.endsWith(".tmp"))
      .sort()
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

export function assertNoUnsavedState(directory: string, ignore: boolean): void {
  const [first] = findUnsavedStates(directory);
  if (!first || ignore) return;
  const shown = path.relative(process.cwd(), first) || first;
  throw new Error(
    `${shown} holds state that was never stored. Run \`cloudgear state push --force --from ${shown}\` (it is removed once pushed), or pass --ignore-unsaved to go on without it`,
  );
}

function uniqueUnsavedFile(directory: string): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  let target = path.join(directory, `${UNSAVED_PREFIX}.${stamp}`);
  for (let n = 1; fs.existsSync(target); n++) target = path.join(directory, `${UNSAVED_PREFIX}.${stamp}-${n}`);
  return target;
}

export function preserveOnFailure(store: StateStore, directory: string): (state: State) => Promise<void> {
  return async (state) => {
    try {
      await store.save(state);
    } catch (err) {
      if (store instanceof LocalStateStore) throw err;
      const unsavedFile = uniqueUnsavedFile(directory);
      const shown = path.relative(process.cwd(), unsavedFile) || unsavedFile;
      let kept = true;
      try {
        writeFileAtomic(unsavedFile, serializeState(state));
      } catch {
        kept = false;
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        kept
          ? `${reason}\nThe state could not be saved to ${store.describe()}. What this run recorded so far is in ${shown}. Inspect it, then run \`cloudgear state push --force --from ${shown}\` with the same --state. Do NOT run apply again before that: resources created by this run are missing from the remote state`
          : `${reason}\nThe state could not be saved to ${store.describe()} and ${shown} could not be written either`,
        { cause: err },
      );
    }
  };
}

export interface LockHandle {
  release(): Promise<void>;
  signal: AbortSignal;
  interrupt(): void;
}

export interface HoldLockOptions {
  warn?: (message: string) => void;
  exit?: (code: number) => never;
  releaseTimeoutMs?: number;
}

const STALE_HINT = "run `cloudgear state unlock --force` after checking that no run is active";

function releaseWithin(release: Release, ms: number): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([release(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

export async function holdLock(store: StateStore, request: LockRequest, options: HoldLockOptions = {}): Promise<LockHandle> {
  const warn = options.warn ?? ((message: string) => console.error(`cloudgear: ${message}`));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const controller = new AbortController();
  if (store instanceof LocalStateStore) {
    return { release: async () => {}, signal: controller.signal, interrupt: () => exit(130) };
  }
  let held: Release | undefined;
  let interrupts = 0;
  const interrupt = () => {
    interrupts++;
    if (interrupts === 1) {
      controller.abort();
      warn("interrupted; finishing the current step and releasing the lock (interrupt again to exit at once)");
      return;
    }
    warn(held ? `exiting with the lock still held; ${STALE_HINT}` : `exiting while the lock was being taken; if the state stays locked, ${STALE_HINT}`);
    exit(130);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const detach = () => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  };
  try {
    held = await store.lock(request);
  } catch (err) {
    detach();
    throw err;
  }
  let released: Promise<void> | undefined;
  const release = () => {
    detach();
    released ??= releaseWithin(held!, options.releaseTimeoutMs ?? 10_000).catch((err) =>
      warn(`lock not released (${err instanceof Error ? err.message : err}); ${STALE_HINT}`),
    );
    return released;
  };
  if (controller.signal.aborted) {
    await release();
    throw new Error("Interrupted before the command started");
  }
  return { release, signal: controller.signal, interrupt };
}

export interface AskStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  terminal?: boolean;
}

// Resolves false on anything but yes, and when interrupted.
export function ask(question: string, lock?: Pick<LockHandle, "signal" | "interrupt">, streams?: AskStreams): Promise<boolean> {
  if (lock?.signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = readline.createInterface(streams ?? { input: process.stdin, output: process.stdout });
    const onAbort = () => finish("");
    const finish = (answer: string) => {
      lock?.signal.removeEventListener("abort", onAbort);
      resolve(/^y/i.test(answer.trim()));
      rl.close();
    };
    lock?.signal.addEventListener("abort", onAbort);
    rl.on("close", () => finish(""));
    rl.on("SIGINT", () => (lock ? lock.interrupt() : process.exit(130)));
    rl.question(question, finish);
  });
}
