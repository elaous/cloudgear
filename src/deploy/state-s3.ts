import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { debug } from "@cloudgear/debug";
import { parseState, serializeState, writeFileAtomic, type State } from "./state";
import type { LockRequest, StateStore } from "./state-store";

export interface S3Location {
  bucket: string;
  prefix: string;
  region?: string;
}

export interface LockInfo {
  id: string;
  holder: string;
  command: string;
  since: string;
  pid: number;
}

export interface S3Sender {
  send(command: unknown): Promise<unknown>;
}

export interface S3StateStoreOptions {
  client?: S3Sender;
  cachePath?: string;
  warn?: (message: string) => void;
  holder?: string;
}

export const STATE_CHANGED = "state changed remotely since it was read; run the command again";

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function parseS3Location(url: string): S3Location {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?$/.exec(url);
  if (!match) throw new Error(`State location "${url}" must look like s3://<bucket>/<prefix>`);
  const [, scheme, bucket = "", rawPath = "", query = ""] = match;
  if (scheme!.toLowerCase() !== "s3") throw new Error(`State location "${url}" must use the s3:// scheme, not ${scheme}://`);
  if (!bucket) throw new Error(`State location "${url}" has no bucket; expected s3://<bucket>/<prefix>`);
  if (!BUCKET.test(bucket)) throw new Error(`State location "${url}" has an invalid bucket name "${bucket}"`);
  const segments = rawPath.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  for (const segment of segments) {
    if (segment === "..") throw new Error(`State location "${url}" must not contain ".."`);
    if (segment === "" || segment === ".") throw new Error(`State location "${url}" has an empty or "." path segment`);
  }
  const params = new URLSearchParams(query);
  for (const name of params.keys()) {
    if (name !== "region") throw new Error(`State location "${url}" has an unknown option "${name}"; only region is supported`);
  }
  const region = params.get("region") ?? undefined;
  if (params.has("region") && !region) throw new Error(`State location "${url}" has an empty region`);
  return { bucket, prefix: segments.length ? `${segments.join("/")}/` : "", ...(region ? { region } : {}) };
}

interface SdkError {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

const statusOf = (err: unknown) => (err as SdkError)?.$metadata?.httpStatusCode;
const nameOf = (err: unknown) => (err as SdkError)?.name;
const isPreconditionFailed = (err: unknown) => nameOf(err) === "PreconditionFailed" || statusOf(err) === 412;
const isConflict = (err: unknown) => nameOf(err) === "ConditionalRequestConflict" || statusOf(err) === 409;
const isNotFound = (err: unknown) => nameOf(err) === "NoSuchKey" || nameOf(err) === "NotFound" || statusOf(err) === 404;

function defaultHolder(): string {
  let user = process.env.USER ?? "unknown";
  try {
    user = os.userInfo().username;
  } catch {}
  return `${user}@${os.hostname()}`;
}

export function describeLock(info: LockInfo | undefined): string {
  return info ? `${info.holder} since ${info.since} (command ${info.command})` : "an unknown holder";
}

export class S3StateStore implements StateStore {
  readonly stateKey: string;
  readonly lockKey: string;
  readonly endpointsKey: string;
  private sdk?: Promise<typeof import("@aws-sdk/client-s3")>;
  private client?: Promise<S3Sender>;
  private known = false;
  private etag?: string;
  private firstLoad = true;

  constructor(
    readonly location: S3Location,
    private readonly options: S3StateStoreOptions = {},
  ) {
    this.stateKey = `${location.prefix}state.json`;
    this.lockKey = `${location.prefix}state.lock`;
    this.endpointsKey = `${location.prefix}endpoints.json`;
  }

  describe(): string {
    return `s3://${this.location.bucket}/${this.location.prefix}`;
  }

  get version(): string | undefined {
    return this.etag;
  }

  async load(project: string, provider: string): Promise<{ state: State; version?: string }> {
    const remote = await this.readRemote();
    if (!remote) {
      this.warnOnDivergence(undefined);
      return { state: { version: 1, project, provider, entries: {} } };
    }
    const state = parseState(remote.text, `${this.describe()}state.json`, project, provider);
    this.warnOnDivergence(remote.text);
    this.mirror(remote.text, remote.etag);
    return { state, version: remote.etag };
  }

  async save(state: State): Promise<void> {
    if (!this.known) throw new Error("The remote state was not read before it was saved");
    const text = serializeState(state);
    const etag = await this.putState(text);
    this.etag = etag;
    debug("state", "remote state saved", { key: this.stateKey, entries: Object.keys(state.entries).length });
    this.mirror(text, etag);
  }

  async readRemote(): Promise<{ text: string; etag: string } | undefined> {
    const object = await this.get(this.stateKey);
    this.known = true;
    this.etag = object?.etag;
    debug("state", "remote state read", { key: this.stateKey, exists: !!object });
    return object;
  }

  async readEndpoints(): Promise<string | undefined> {
    return (await this.get(this.endpointsKey))?.text;
  }

  async saveEndpoints(json: string | undefined): Promise<void> {
    if (json === undefined) {
      await this.send("DeleteObjectCommand", { Bucket: this.location.bucket, Key: this.endpointsKey });
      return;
    }
    await this.put(this.endpointsKey, json, {});
  }

  async lock(request: LockRequest): Promise<() => Promise<void>> {
    const info: LockInfo = {
      id: randomUUID(),
      holder: this.options.holder ?? defaultHolder(),
      command: request.command.slice(0, 200),
      since: new Date().toISOString(),
      pid: process.pid,
    };
    try {
      await this.put(this.lockKey, JSON.stringify(info), { IfNoneMatch: "*" });
    } catch (err) {
      if (!isPreconditionFailed(err) && !isConflict(err)) throw this.withHint(err, this.lockKey);
      const held = await this.readLock();
      if (!held) throw new Error("The state lock changed while it was being taken; run the command again");
      throw new Error(`state is locked by ${describeLock(held.info)}; if that run is dead, run cloudgear state unlock --force`);
    }
    debug("state", "lock taken", { key: this.lockKey, id: info.id });
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const held = await this.readLock();
      if (!held || held.info?.id !== info.id) return;
      try {
        await this.send("DeleteObjectCommand", { Bucket: this.location.bucket, Key: this.lockKey, IfMatch: held.etag });
      } catch (err) {
        if (isPreconditionFailed(err) || isNotFound(err)) return;
        throw err;
      }
      debug("state", "lock released", { key: this.lockKey, id: info.id });
    };
  }

  async readLock(): Promise<{ info: LockInfo | undefined; etag: string } | undefined> {
    const object = await this.get(this.lockKey);
    if (!object) return undefined;
    let info: LockInfo | undefined;
    try {
      info = JSON.parse(object.text) as LockInfo;
    } catch {}
    return { info, etag: object.etag };
  }

  async forceUnlock(): Promise<LockInfo | undefined> {
    const held = await this.readLock();
    if (!held) return undefined;
    await this.send("DeleteObjectCommand", { Bucket: this.location.bucket, Key: this.lockKey });
    debug("state", "lock removed", { key: this.lockKey });
    return held.info ?? ({ holder: "unknown", command: "unknown", since: "unknown", id: "", pid: 0 } satisfies LockInfo);
  }

  async pull(directory: string): Promise<{ state: boolean; endpoints: boolean }> {
    const remote = await this.readRemote();
    if (!remote) throw new Error(`No state at ${this.describe()}state.json`);
    this.warnOnDivergence(remote.text);
    this.backupIfDiffers(path.join(directory, "state.json"), remote.text);
    writeFileAtomic(path.join(directory, "state.json"), remote.text);
    this.writeMarker(directory, remote.etag);
    const endpoints = await this.readEndpoints();
    const endpointsFile = path.join(directory, "endpoints.json");
    if (endpoints === undefined) fs.rmSync(endpointsFile, { force: true });
    else writeFileAtomic(endpointsFile, endpoints);
    return { state: true, endpoints: endpoints !== undefined };
  }

  private async putState(text: string): Promise<string> {
    const condition = this.etag ? { IfMatch: this.etag } : { IfNoneMatch: "*" };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.put(this.stateKey, text, condition);
      } catch (err) {
        if (isPreconditionFailed(err)) throw new Error(STATE_CHANGED);
        if (isConflict(err)) {
          if (attempt === 0) continue;
          throw new Error(STATE_CHANGED);
        }
        throw this.withHint(err, this.stateKey);
      }
    }
  }

  private async put(key: string, text: string, condition: { IfMatch?: string; IfNoneMatch?: string }): Promise<string> {
    const res = (await this.send("PutObjectCommand", {
      Bucket: this.location.bucket,
      Key: key,
      Body: text,
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
      ...condition,
    })) as { ETag?: string };
    if (!res.ETag) throw new Error(`The bucket returned no ETag for ${key}`);
    return res.ETag;
  }

  private async get(key: string): Promise<{ text: string; etag: string } | undefined> {
    try {
      const res = (await this.send("GetObjectCommand", { Bucket: this.location.bucket, Key: key })) as {
        Body?: { transformToString(): Promise<string> };
        ETag?: string;
      };
      if (!res.Body || !res.ETag) throw new Error(`The bucket returned no body or ETag for ${key}`);
      return { text: await res.Body.transformToString(), etag: res.ETag };
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw this.withHint(err, key);
    }
  }

  private async send(command: string, input: Record<string, unknown>): Promise<unknown> {
    const sdk = await this.loadSdk();
    const Command = (sdk as unknown as Record<string, new (input: Record<string, unknown>) => unknown>)[command]!;
    return (await this.getClient()).send(new Command(input));
  }

  private loadSdk() {
    this.sdk ??= import("@aws-sdk/client-s3");
    return this.sdk;
  }

  private getClient(): Promise<S3Sender> {
    this.client ??= this.options.client
      ? Promise.resolve(this.options.client)
      : this.loadSdk().then((sdk) => {
          const region = this.location.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
          return new sdk.S3Client(region ? { region } : {});
        });
    return this.client;
  }

  private withHint(err: unknown, key: string): unknown {
    if (nameOf(err) !== "AccessDenied" && statusOf(err) !== 403) return err;
    return new Error(
      `Access denied to s3://${this.location.bucket}/${key}: the credentials need s3:GetObject, s3:PutObject and s3:DeleteObject on the prefix, and s3:ListBucket on the bucket`,
      { cause: err },
    );
  }

  private get cacheDir(): string | undefined {
    return this.options.cachePath ? path.dirname(this.options.cachePath) : undefined;
  }

  private get markerFile(): string | undefined {
    return this.cacheDir ? path.join(this.cacheDir, "state.remote.json") : undefined;
  }

  private writeMarker(directory: string, etag: string): void {
    writeFileAtomic(path.join(directory, "state.remote.json"), `${JSON.stringify({ location: this.describe(), etag }, null, 2)}\n`);
  }

  private ownsCache(): boolean {
    try {
      return JSON.parse(fs.readFileSync(this.markerFile!, "utf8")).location === this.describe();
    } catch {
      return false;
    }
  }

  private readLocal(file: string): string | undefined {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  }

  private sameState(a: string, b: string): boolean {
    try {
      return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
    } catch {
      return a === b;
    }
  }

  private warnOnDivergence(remoteText: string | undefined): void {
    if (!this.firstLoad) return;
    this.firstLoad = false;
    const file = this.options.cachePath;
    const local = file ? this.readLocal(file) : undefined;
    if (!file || local === undefined || this.ownsCache()) return;
    if (remoteText !== undefined && this.sameState(local, remoteText)) return;
    const warn = this.options.warn ?? ((message: string) => console.warn(`warning: ${message}`));
    const name = path.relative(process.cwd(), file) || file;
    warn(
      remoteText === undefined
        ? `${name} exists but ${this.describe()} holds no state, so the remote is treated as empty. To migrate the local state, run \`cloudgear state push\``
        : `${name} differs from the remote state at ${this.describe()}; the remote is used and the local copy is replaced (kept as ${path.basename(file)}.pre-remote). To migrate the local state instead, run \`cloudgear state push --force\``,
    );
  }

  private backupIfDiffers(file: string, text: string): void {
    if (this.ownsCache()) return;
    const local = this.readLocal(file);
    if (local === undefined || this.sameState(local, text)) return;
    writeFileAtomic(`${file}.pre-remote`, local);
  }

  private mirror(text: string, etag: string): void {
    const file = this.options.cachePath;
    if (!file) return;
    try {
      this.backupIfDiffers(file, text);
      writeFileAtomic(file, text);
      this.writeMarker(path.dirname(file), etag);
    } catch (err) {
      debug("state", "local cache not written", { error: (err as Error).message });
    }
  }
}
