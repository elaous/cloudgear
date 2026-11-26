import type { S3Client } from "@aws-sdk/client-s3";
import { debug, timed } from "@cloudgear/debug";
import {
  createBlobDriver,
  parseBlobUri,
  type BlobData,
  type BlobDriver,
  type BlobProvider,
} from "./driver";
import { BLOB_STORE_OPERATIONS, BLOB_STORE_WEB_SITE_DEFAULTS, CORS_METHODS } from "./schema.gen";

export {
  BLOB_PROVIDERS,
  BLOB_STORE_FIELDS,
  BLOB_STORE_WEB_SITE_DEFAULTS,
  BLOB_STORE_WEB_SITE_FIELDS,
  CACHE_CONTROL_RULE_FIELDS,
  CORS_METHODS,
  CORS_RULE_FIELDS,
  SITE_FILES_FIELDS,
} from "./schema.gen";

export { assertS3BucketName, registerBlobDriver, parseBlobUri, S3_BUCKET_NAME, URI_SCHEMES } from "./driver";
export type { BlobData, BlobDriver, BlobDriverFactory, BlobDriverOptions, BlobProvider } from "./driver";

// The client `client()` returns for each provider.
export interface BlobClients {
  aws: S3Client;
  gcp: unknown;
  azure: unknown;
}

export type BlobAccess = "read" | "write" | "delete" | "list";

export const BLOB_OPERATIONS = BLOB_STORE_OPERATIONS satisfies Partial<Record<keyof BlobStore, readonly BlobAccess[]>>;

export interface BlobStoreOptions {
  path?: string;
  // Literal only: generate creates the bucket in this region.
  region?: string;
  // Literals only; read by generate.
  options?: ProviderOptions;
  driver?: BlobDriver;
}

export type ProviderOptions = Record<string, string | number | boolean>;

export type CorsMethod = (typeof CORS_METHODS)[number];

export interface CorsRule {
  // "*" or an origin like "https://example.com".
  origins: string[];
  methods: CorsMethod[];
  headers?: string[];
  exposeHeaders?: string[];
  maxAgeSeconds?: number;
}

export interface CacheControlRule {
  // A glob such as "assets/**", over paths in the directory.
  match: string;
  // The Cache-Control header value.
  value: string;
}

export interface SiteFiles {
  // "./x" is relative to the setup file; else the project root.
  dir: string;
  include?: string[];
  exclude?: string[];
  // Deletes uploaded files that left the directory; off by default.
  prune?: boolean;
  // The first matching rule wins.
  cacheControl?: CacheControlRule[];
}

export interface BlobStoreWebSiteOptions extends BlobStoreOptions {
  // A file name without "/"; default "index.html".
  indexDocument?: string;
  errorDocument?: string;
  // Literal only; read by generate.
  files?: SiteFiles;
  // Literals only; read by generate.
  cors?: CorsRule[];
}

const ORIGIN = /^([a-z][a-z0-9+.-]*):\/\/([^\s/]+)$/i;

// "*", or scheme://host where the host has a character besides "*".
function isOrigin(origin: string): boolean {
  if (origin === "*") return true;
  const match = ORIGIN.exec(origin);
  return match !== null && match[2]!.replaceAll("*", "") !== "";
}
const MAX_CORS_RULES = 100;
const MAX_AGE_SECONDS = 31_536_000;

function assertStrings(value: unknown, what: string, at: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) throw new Error(`${at}: ${what} must be a list of non-empty strings`);
}

export function assertCorsRules(rules: readonly CorsRule[], at: string): void {
  if (rules.length === 0 || rules.length > MAX_CORS_RULES) throw new Error(`${at}: cors takes 1 to ${MAX_CORS_RULES} rules, got ${rules.length}`);
  rules.forEach((rule, i) => {
    const where = `${at}: cors[${i}]`;
    assertStrings(rule.origins, "origins", where);
    if (rule.origins.length === 0) throw new Error(`${where}: origins must not be empty`);
    for (const origin of rule.origins) {
      if (!isOrigin(origin) || origin.split("*").length > 2) throw new Error(`${where}: origin "${origin}" must be "*" or look like "https://example.com", with at most one "*"`);
    }
    assertStrings(rule.methods, "methods", where);
    if (rule.methods.length === 0) throw new Error(`${where}: methods must not be empty`);
    for (const method of rule.methods) {
      if (!(CORS_METHODS as readonly string[]).includes(method)) throw new Error(`${where}: method "${method}" must be one of ${CORS_METHODS.join(", ")}`);
    }
    if (new Set(rule.methods).size !== rule.methods.length) throw new Error(`${where}: methods lists a method twice`);
    if (rule.headers !== undefined) assertStrings(rule.headers, "headers", where);
    if (rule.exposeHeaders !== undefined) assertStrings(rule.exposeHeaders, "exposeHeaders", where);
    if (rule.maxAgeSeconds !== undefined && !(Number.isInteger(rule.maxAgeSeconds) && rule.maxAgeSeconds >= 0 && rule.maxAgeSeconds <= MAX_AGE_SECONDS)) {
      throw new Error(`${where}: maxAgeSeconds must be an integer from 0 to ${MAX_AGE_SECONDS}`);
    }
  });
}

function assertGlobs(patterns: readonly string[], what: string, at: string): void {
  for (const pattern of patterns) {
    if (/^(\.\/|\/|!)/.test(pattern)) throw new Error(`${at}: ${what} "${pattern}" must not start with "./", "/" or "!"; globs match paths such as "assets/app.js"`);
  }
}

export function assertSiteFiles(files: SiteFiles, at: string): void {
  const where = `${at}: files`;
  if (typeof files.dir !== "string" || files.dir.trim() === "") throw new Error(`${where}.dir must be a non-empty string`);
  if (files.include !== undefined) {
    assertStrings(files.include, "files.include", at);
    assertGlobs(files.include, "files.include", at);
  }
  if (files.exclude !== undefined) {
    assertStrings(files.exclude, "files.exclude", at);
    assertGlobs(files.exclude, "files.exclude", at);
  }
  if (files.prune !== undefined && typeof files.prune !== "boolean") throw new Error(`${where}.prune must be true or false`);
  files.cacheControl?.forEach((rule, i) => {
    if (typeof rule.match !== "string" || rule.match === "") throw new Error(`${where}.cacheControl[${i}].match must be a non-empty glob`);
    assertGlobs([rule.match], `files.cacheControl[${i}].match`, at);
    if (typeof rule.value !== "string" || rule.value === "" || /[\r\n]/.test(rule.value)) throw new Error(`${where}.cacheControl[${i}].value must be a one-line header value`);
  });
}

export function assertWebSiteDocuments(options: { indexDocument?: string; errorDocument?: string }, at: string): void {
  const { indexDocument, errorDocument } = options;
  if (indexDocument !== undefined && !/^[^/]{1,255}$/.test(indexDocument)) throw new Error(`${at}: indexDocument must be a file name without "/", such as "index.html"`);
  if (errorDocument !== undefined && !/^[^/][^\r\n]{0,1023}$/.test(errorDocument)) throw new Error(`${at}: errorDocument must be a key that does not start with "/", such as "404.html"`);
}

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
    if (driver.client === undefined) throw new Error(`The ${this.provider} blob driver in use has no client (the in-memory driver, used when CLOUDGEAR_BLOB_DRIVER=memory, never has one)`);
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
