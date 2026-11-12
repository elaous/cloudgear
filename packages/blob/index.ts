import type { S3Client } from "@aws-sdk/client-s3";
import { debug, timed } from "@cloudgear/debug";
import {
  createBlobDriver,
  parseBlobUri,
  type BlobData,
  type BlobDriver,
  type BlobProvider,
} from "./driver";

export { registerBlobDriver, parseBlobUri, URI_SCHEMES } from "./driver";
export type { BlobData, BlobDriver, BlobDriverFactory, BlobDriverOptions, BlobProvider } from "./driver";

// The client `client()` returns for each provider.
export interface BlobClients {
  aws: S3Client;
  gcp: unknown;
  azure: unknown;
}

export type BlobAccess = "read" | "write" | "delete" | "list";

export const BLOB_OPERATIONS = {
  get: ["read"],
  getText: ["read"],
  getJson: ["read"],
  exists: ["read", "list"],
  put: ["write"],
  delete: ["delete"],
  list: ["list"],
} as const satisfies Partial<Record<keyof BlobStore, readonly BlobAccess[]>>;

export interface BlobStoreOptions {
  path?: string;
  // Literal only: generate creates the bucket in this region.
  region?: string;
  // Literals only; read by generate.
  options?: ProviderOptions;
  driver?: BlobDriver;
}

export type ProviderOptions = Record<string, string | number | boolean>;

// Prefix gets a trailing slash; bucket root is an empty string.
export function normalizeBlobPath(path: string): string {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Invalid blob path "${path}": empty, "." and ".." segments are not allowed`);
  }
  // Wildcards and `$` widen or expand the IAM resource.
  if (/[*?$]/.test(trimmed)) throw new Error(`Invalid blob path "${path}": "*", "?" and "$" are not allowed`);
  return `${trimmed}/`;
}

// Runtime no-op; `cloudgear generate` reads it.
export function grant(_store: BlobStore, ..._accesses: BlobAccess[]): void {}

export const permissions = { Get: "read", Put: "write", Delete: "delete", List: "list" } as const satisfies Record<string, BlobAccess>;

export interface PolicyOptions {
  permissions: readonly BlobAccess[];
}

// Literals only; grants exactly these permissions on `store`.
export function policy(_store: BlobStore, _options: PolicyOptions) {
  return (_method: unknown, _context: ClassMethodDecoratorContext): void => {};
}

function withDebug(driver: BlobDriver, store: string): BlobDriver {
  const run = <T>(op: string, key: string, call: () => Promise<T>, extra: () => Record<string, unknown> = () => ({})) =>
    timed("blob", `${op} ${key}`, call, () => ({ store, ...extra() }));
  return {
    get: (key) => run("get", key, () => driver.get(key)),
    put: (key, data, contentType) => run("put", key, () => driver.put(key, data, contentType), () => ({ bytes: data.byteLength, contentType })),
    delete: (key) => run("delete", key, () => driver.delete(key)),
    list: (prefix) => run("list", prefix, () => driver.list(prefix)),
    exists: (key) => run("exists", key, () => driver.exists(key)),
    client: driver.client,
  };
}

export class BlobStore<P extends BlobProvider = BlobProvider> {
  readonly name: string;
  readonly path: string;
  readonly region: string | undefined;
  private driverPromise?: Promise<BlobDriver>;

  constructor(
    readonly provider: P,
    uri: string,
    options: BlobStoreOptions = {},
  ) {
    this.name = parseBlobUri(provider, uri);
    this.path = normalizeBlobPath(options.path ?? "");
    this.region = options.region;
    if (options.driver) this.driverPromise = Promise.resolve(options.driver);
  }

  static envVarFor(name: string): string {
    return `CLOUDGEAR_BLOB_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  }

  get location(): string {
    return process.env[BlobStore.envVarFor(this.name)] ?? this.name;
  }

  url(key = ""): string {
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    return `https://${this.location}/${this.path}${encoded}`;
  }

  async get(key: string): Promise<Uint8Array | null> {
    return (await this.driver()).get(this.path + key);
  }

  async getText(key: string): Promise<string | null> {
    const bytes = await this.get(key);
    return bytes && new TextDecoder().decode(bytes);
  }

  async getJson<T = unknown>(key: string): Promise<T | null> {
    const text = await this.getText(key);
    return text === null ? null : (JSON.parse(text) as T);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.driver()).exists(this.path + key);
  }

  async put(key: string, data: BlobData | object, options: { contentType?: string } = {}): Promise<void> {
    const driver = await this.driver();
    if (typeof data === "string") {
      return driver.put(this.path + key, new TextEncoder().encode(data), options.contentType ?? "text/plain");
    }
    if (data instanceof Uint8Array) return driver.put(this.path + key, data, options.contentType);
    return driver.put(
      this.path + key,
      new TextEncoder().encode(JSON.stringify(data)),
      options.contentType ?? "application/json",
    );
  }

  async delete(key: string): Promise<void> {
    return (await this.driver()).delete(this.path + key);
  }

  // The provider's own client, bound to this store's region. Calls made through it are not
  // analyzed: cloudgear grants every operation on the store unless `grant(store, ...)` narrows it.
  async client(): Promise<BlobClients[P]> {
    const driver = await this.driver();
    if (driver.client === undefined) throw new Error(`The ${this.provider} blob driver in use has no client (it is the in-memory driver when CLOUDGEAR_BLOB_DRIVER=memory)`);
    return driver.client as BlobClients[P];
  }

  async list(prefix = ""): Promise<string[]> {
    const keys = await (await this.driver()).list(this.path + prefix);
    return keys.map((key) => key.slice(this.path.length));
  }

  private driver(): Promise<BlobDriver> {
    this.driverPromise ??= createBlobDriver(this.provider, this.location, { region: this.region })
      .then((driver) => {
        debug("blob", `driver ready for ${this.provider}://${this.location}`, { path: this.path, region: this.region });
        return withDebug(driver, `${this.provider}://${this.location}`);
      })
      .catch((err) => {
        this.driverPromise = undefined;
        throw err;
      });
    return this.driverPromise;
  }
}
