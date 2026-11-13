import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GetObjectCommandOutput, PutObjectCommandOutput } from "@aws-sdk/client-s3";
import { debug } from "@cloudgear/debug";
import { parseState, serializeState, writeFileAtomic, type State } from "./state";
import { readRemoteMarker, MARKER_FILE, type LockRequest, type Release, type StateStore } from "./state-store";

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
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface S3StateStoreOptions {
  client?: S3Sender;
  cachePath?: string;
  warn?: (message: string) => void;
  holder?: string;
}

export const STATE_CHANGED = "state changed remotely since it was read";
export const STATE_DELETED = "state was deleted remotely since it was read";

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
const isNotFound = (err: unknown) => nameOf(err) === "NoSuchKey" || nameOf(err) === "NotFound" || (statusOf(err) === 404 && nameOf(err) !== "NoSuchBucket");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

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

interface Condition {
  ifMatch?: string;
  ifNoneMatch?: string;
}

export class S3StateStore implements StateStore {
  readonly stateKey: string;
  readonly lockKey: string;
  readonly endpointsKey: string;
  unpushedLocalEntries?: number;
  private sdk?: Promise<typeof import("@aws-sdk/client-s3")>;
  private client?: Promise<S3Sender>;
  private known = false;
  private etag?: string;
  private firstLoad = true;
  private backedUp?: string;
  private remoteMissing = false;

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
      this.checkLocalCopy(undefined);
      return { state: { version: 1, project, provider, entries: {} } };
    }
    const state = parseState(remote.text, `${this.describe()}state.json`, project, provider);
    this.checkLocalCopy(remote.text);
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
      await this.remove(this.endpointsKey, {});
      return;
    }
    await this.put(this.endpointsKey, json, {});
  }

  async lock(request: LockRequest): Promise<Release> {
    const info: LockInfo = {
      id: randomUUID(),
      holder: this.options.holder ?? defaultHolder(),
      command: request.command.slice(0, 200),
      since: new Date().toISOString(),
      pid: process.pid,
    };
    try {
      await this.put(this.lockKey, JSON.stringify(info), { ifNoneMatch: "*" });
    } catch (err) {
      if (!isPreconditionFailed(err) && !isConflict(err)) throw this.withHint(err, this.lockKey);
      const held = await this.readLock();
      if (!held) throw new Error("The state lock changed while it was being taken; run the command again");
      if (held.info?.id !== info.id) {
        throw new Error(`state is locked by ${describeLock(held.info)}; if that run is dead, run cloudgear state unlock --force`);
      }
    }
    debug("state", "lock taken", { key: this.lockKey, id: info.id });
    let released = false;
    return async (signal) => {
      if (released) return;
      released = true;
      const held = await this.readLock(signal);
      const warn = this.warnFn();
      if (!held) {
        warn(`the lock at ${this.describe()}state.lock was already removed before this run released it`);
        return;
      }
      if (held.info?.id !== info.id) {
        warn(`the lock at ${this.describe()}state.lock is now held by ${describeLock(held.info)}; it was left alone`);
        return;
      }
      try {
        await this.remove(this.lockKey, { ifMatch: held.etag }, signal);
      } catch (err) {
        if (isPreconditionFailed(err) || isNotFound(err)) {
          warn(`the lock at ${this.describe()}state.lock changed while it was being released; it was left alone`);
          return;
        }
        throw err;
      }
      debug("state", "lock released", { key: this.lockKey, id: info.id });
    };
  }

  async readLock(signal?: AbortSignal): Promise<{ info: LockInfo | undefined; etag: string } | undefined> {
    const object = await this.get(this.lockKey, signal);
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
    try {
      await this.remove(this.lockKey, { ifMatch: held.etag });
    } catch (err) {
      if (isPreconditionFailed(err)) throw new Error("The lock changed while it was being removed; check who holds it with cloudgear state show");
      if (!isNotFound(err)) throw err;
    }
    debug("state", "lock removed", { key: this.lockKey });
    return held.info ?? ({ holder: "unknown", command: "unknown", since: "unknown", id: "", pid: 0 } satisfies LockInfo);
  }

  async pull(directory: string): Promise<{ state: boolean; endpoints: boolean }> {
    const remote = await this.readRemote();
    if (!remote) throw new Error(`No state at ${this.describe()}state.json`);
    this.checkLocalCopy(remote.text);
    this.mirror(remote.text, remote.etag, directory);
    const endpoints = await this.readEndpoints();
    const endpointsFile = path.join(directory, "endpoints.json");
    if (endpoints === undefined) fs.rmSync(endpointsFile, { force: true });
    else writeFileAtomic(endpointsFile, endpoints);
    return { state: true, endpoints: endpoints !== undefined };
  }

  private async putState(text: string): Promise<string> {
    const condition: Condition = this.etag ? { ifMatch: this.etag } : { ifNoneMatch: "*" };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.put(this.stateKey, text, condition);
      } catch (err) {
        const conflict = isConflict(err);
        if (conflict && attempt === 0) continue;
        if (isPreconditionFailed(err) || conflict) {
          const current = await this.get(this.stateKey);
          if (current?.text === text) return current.etag;
          throw new Error(STATE_CHANGED);
        }
        if (isNotFound(err) && this.etag) throw new Error(STATE_DELETED);
        throw this.withHint(err, this.stateKey);
      }
    }
  }

  private async put(key: string, text: string, condition: Condition): Promise<string> {
    const sdk = await this.loadSdk();
    const res = (await (await this.getClient()).send(
      new sdk.PutObjectCommand({
        Bucket: this.location.bucket,
        Key: key,
        Body: text,
        ContentType: "application/json",
        IfMatch: condition.ifMatch,
        IfNoneMatch: condition.ifNoneMatch,
      }),
    )) as PutObjectCommandOutput;
    if (!res.ETag) throw new Error(`The bucket returned no ETag for ${key}`);
    return res.ETag;
  }

  private async get(key: string, signal?: AbortSignal): Promise<{ text: string; etag: string } | undefined> {
    const sdk = await this.loadSdk();
    try {
      const res = (await (await this.getClient()).send(new sdk.GetObjectCommand({ Bucket: this.location.bucket, Key: key }), { abortSignal: signal })) as GetObjectCommandOutput;
      if (!res.Body || !res.ETag) throw new Error(`The bucket returned no body or ETag for ${key}`);
      return { text: await res.Body.transformToString(), etag: res.ETag };
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw this.withHint(err, key);
    }
  }

  private async remove(key: string, condition: Condition, signal?: AbortSignal): Promise<void> {
    const sdk = await this.loadSdk();
    await (await this.getClient()).send(new sdk.DeleteObjectCommand({ Bucket: this.location.bucket, Key: key, IfMatch: condition.ifMatch }), { abortSignal: signal });
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
          return new sdk.S3Client({ ...(region ? { region } : {}), followRegionRedirects: true });
        });
    return this.client;
  }

  private withHint(err: unknown, key: string): unknown {
    if (nameOf(err) === "NoSuchBucket") {
      return new Error(`The bucket ${this.location.bucket} does not exist; cloudgear does not create it`, { cause: err });
    }
    if (nameOf(err) !== "AccessDenied" && statusOf(err) !== 403) return err;
    return new Error(
      `Access denied to s3://${this.location.bucket}/${key}: the credentials need s3:GetObject, s3:PutObject and s3:DeleteObject on the prefix, and s3:ListBucket on the bucket (plus kms:Decrypt and kms:GenerateDataKey when the bucket encrypts with a KMS key)`,
      { cause: err },
    );
  }

  private warnFn(): (message: string) => void {
    return this.options.warn ?? ((message: string) => console.warn(`warning: ${message}`));
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

  private entryCount(text: string): number {
    try {
      return Object.keys((JSON.parse(text) as State).entries ?? {}).length;
    } catch {
      return 0;
    }
  }

  // True when the file is exactly what this store last mirrored.
  private cacheIntact(file: string, local: string | undefined): boolean {
    const marker = readRemoteMarker(path.dirname(file));
    return !!marker && local !== undefined && marker.location === this.describe() && marker.sha256 === sha256(local);
  }

  private checkLocalCopy(remoteText: string | undefined): void {
    this.remoteMissing = remoteText === undefined;
    if (!this.firstLoad) return;
    this.firstLoad = false;
    const file = this.options.cachePath;
    const local = file ? this.readLocal(file) : undefined;
    if (!file || local === undefined) return;
    const warn = this.warnFn();
    const name = path.relative(process.cwd(), file) || file;
    const intact = this.cacheIntact(file, local);
    if (remoteText === undefined) {
      const entries = this.entryCount(local);
      if (!entries) return;
      this.unpushedLocalEntries = entries;
      warn(
        intact
          ? `${this.describe()} holds no state any more, although ${name} was mirrored from it. Run \`cloudgear state push\` to restore it`
          : `${name} holds ${entries} entries but ${this.describe()} holds no state, so the remote is treated as empty. To migrate the local state, run \`cloudgear state push\``,
      );
      return;
    }
    if (intact || this.sameState(local, remoteText)) return;
    const kept = this.backupLocal(file, local);
    warn(
      `${name} differs from the remote state at ${this.describe()}; the remote is used and the local copy is replaced${kept ? ` (kept as ${path.basename(kept)})` : ""}. To migrate the local state instead, run \`cloudgear state push --force\``,
    );
  }

  private backupLocal(file: string, local: string): string | undefined {
    const digest = sha256(local);
    if (this.backedUp === digest) return undefined;
    const stamp = new Date().toISOString().replace(/[-:.]/g, "");
    let target = `${file}.pre-remote-${stamp}`;
    for (let n = 1; fs.existsSync(target); n++) target = `${file}.pre-remote-${stamp}-${n}`;
    writeFileAtomic(target, local);
    this.backedUp = digest;
    return target;
  }

  private mirror(text: string, etag: string, directory?: string): void {
    const file = directory ? path.join(directory, "state.json") : this.options.cachePath;
    if (!file) return;
    try {
      const local = this.readLocal(file);
      if (local !== undefined && (!this.cacheIntact(file, local) || this.remoteMissing) && !this.sameState(local, text)) this.backupLocal(file, local);
      this.remoteMissing = false;
      writeFileAtomic(file, text);
      writeFileAtomic(path.join(path.dirname(file), MARKER_FILE), `${JSON.stringify({ location: this.describe(), etag, sha256: sha256(text) }, null, 2)}\n`);
    } catch (err) {
      debug("state", "local cache not written", { error: (err as Error).message });
    }
  }
}
