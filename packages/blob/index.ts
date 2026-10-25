import {
  createBlobDriver,
  parseBlobUri,
  type BlobData,
  type BlobDriver,
  type BlobProvider,
} from "./driver";

export { registerBlobDriver, parseBlobUri, URI_SCHEMES } from "./driver";
export type { BlobData, BlobDriver, BlobDriverFactory, BlobDriverOptions, BlobProvider } from "./driver";

export type BlobAccess = "read" | "write" | "delete" | "list";

// Provider-neutral accesses per BlobStore method; `cloudgear generate` maps them to IAM.
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
  // Confines the store to keys under this prefix; `cloudgear generate` scopes its permissions to it.
  path?: string;
  // AWS region of the bucket; defaults to the region the app is deployed to. `cloudgear generate`
  // creates the bucket there, so it MUST be a string literal.
  region?: string;
  driver?: BlobDriver;
}

// "/img-cache" and "img-cache/" both become "img-cache/"; the bucket root is "".
export function normalizeBlobPath(path: string): string {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Invalid blob path "${path}": empty, "." and ".." segments are not allowed`);
  }
  // These would widen the generated IAM resource ("a*") or be expanded by it ("${aws:username}").
  if (/[*?$]/.test(trimmed)) throw new Error(`Invalid blob path "${path}": "*", "?" and "$" are not allowed`);
  return `${trimmed}/`;
}

// Declares that the enclosing function needs these accesses on a store the analyzer cannot trace.
// A no-op at runtime; `cloudgear generate` reads it and stops widening on values passed around.
export function grant(_store: BlobStore, ..._accesses: BlobAccess[]): void {}

// Names for `@policy` permission lists: `permissions.Get`, `permissions.Put`, ...
export const permissions = { Get: "read", Put: "write", Delete: "delete", List: "list" } as const satisfies Record<string, BlobAccess>;

export interface PolicyOptions {
  permissions: readonly BlobAccess[];
}

// Method decorator for a static method of an exported class: the routed function gets exactly these
// permissions on `store`, and `cloudgear generate` fails if the function does more. Needs literals.
// A no-op at runtime.
export function policy(_store: BlobStore, _options: PolicyOptions) {
  return (_method: unknown, _context: ClassMethodDecoratorContext): void => {};
}

export class BlobStore {
  readonly name: string;
  readonly path: string;
  readonly region: string | undefined;
  private driverPromise?: Promise<BlobDriver>;

  constructor(
    readonly provider: BlobProvider,
    uri: string,
    options: BlobStoreOptions = {},
  ) {
    this.name = parseBlobUri(provider, uri);
    this.path = normalizeBlobPath(options.path ?? "");
    this.region = options.region;
    if (options.driver) this.driverPromise = Promise.resolve(options.driver);
  }

  // Env var holding a store's physical name once deployed; `cloudgear generate` sets it.
  static envVarFor(name: string): string {
    return `CLOUDGEAR_BLOB_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  }

  get location(): string {
    return process.env[BlobStore.envVarFor(this.name)] ?? this.name;
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

  async list(prefix = ""): Promise<string[]> {
    const keys = await (await this.driver()).list(this.path + prefix);
    return keys.map((key) => key.slice(this.path.length));
  }

  private driver(): Promise<BlobDriver> {
    this.driverPromise ??= createBlobDriver(this.provider, this.location, { region: this.region }).catch((err) => {
      this.driverPromise = undefined;
      throw err;
    });
    return this.driverPromise;
  }
}
