import {
  createBlobDriver,
  parseBlobUri,
  type BlobData,
  type BlobDriver,
  type BlobProvider,
} from "./driver";

export { registerBlobDriver, parseBlobUri, URI_SCHEMES } from "./driver";
export type { BlobData, BlobDriver, BlobDriverFactory, BlobProvider } from "./driver";

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

export class BlobStore {
  readonly name: string;
  private driverPromise?: Promise<BlobDriver>;

  constructor(
    readonly provider: BlobProvider,
    uri: string,
    driver?: BlobDriver,
  ) {
    this.name = parseBlobUri(provider, uri);
    if (driver) this.driverPromise = Promise.resolve(driver);
  }

  // Env var holding a store's physical name once deployed; `cloudgear generate` sets it.
  static envVarFor(name: string): string {
    return `CLOUDGEAR_BLOB_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  }

  get location(): string {
    return process.env[BlobStore.envVarFor(this.name)] ?? this.name;
  }

  async get(key: string): Promise<Uint8Array | null> {
    return (await this.driver()).get(key);
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
    return (await this.driver()).exists(key);
  }

  async put(key: string, data: BlobData | object, options: { contentType?: string } = {}): Promise<void> {
    const driver = await this.driver();
    if (typeof data === "string") {
      return driver.put(key, new TextEncoder().encode(data), options.contentType ?? "text/plain");
    }
    if (data instanceof Uint8Array) return driver.put(key, data, options.contentType);
    return driver.put(key, new TextEncoder().encode(JSON.stringify(data)), options.contentType ?? "application/json");
  }

  async delete(key: string): Promise<void> {
    return (await this.driver()).delete(key);
  }

  async list(prefix = ""): Promise<string[]> {
    return (await this.driver()).list(prefix);
  }

  private driver(): Promise<BlobDriver> {
    this.driverPromise ??= createBlobDriver(this.provider, this.location).catch((err) => {
      this.driverPromise = undefined;
      throw err;
    });
    return this.driverPromise;
  }
}
