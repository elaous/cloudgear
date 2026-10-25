import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export type BlobProvider = "aws" | "gcp" | "azure";
export type BlobData = string | Uint8Array;

// `cloudgear generate` maps each method to provider permissions through this table.
export const BLOB_OPERATIONS = {
  get: "read",
  getText: "read",
  getJson: "read",
  exists: "probe",
  put: "write",
  delete: "delete",
  list: "list",
} as const;
export type BlobAccess = (typeof BLOB_OPERATIONS)[keyof typeof BLOB_OPERATIONS];

const SCHEMES: Record<BlobProvider, string> = { aws: "s3", gcp: "gs", azure: "az" };

export interface BlobDriver {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  exists(key: string): Promise<boolean>;
}

export class BlobStore {
  readonly name: string;
  private driverInstance?: BlobDriver;

  constructor(
    readonly provider: BlobProvider,
    uri: string,
    driver?: BlobDriver,
  ) {
    this.name = parseBlobUri(provider, uri);
    this.driverInstance = driver;
  }

  // Physical bucket name; deployed functions receive it via CLOUDGEAR_BLOB_<NAME>.
  get bucket(): string {
    return process.env[blobEnvVar(this.name)] ?? this.name;
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.driver.get(key);
  }

  async getText(key: string): Promise<string | null> {
    const bytes = await this.driver.get(key);
    return bytes && new TextDecoder().decode(bytes);
  }

  async getJson<T = unknown>(key: string): Promise<T | null> {
    const text = await this.getText(key);
    return text === null ? null : (JSON.parse(text) as T);
  }

  async exists(key: string): Promise<boolean> {
    return this.driver.exists(key);
  }

  async put(key: string, data: BlobData | object, options: { contentType?: string } = {}): Promise<void> {
    if (typeof data === "string") {
      return this.driver.put(key, new TextEncoder().encode(data), options.contentType ?? "text/plain");
    }
    if (data instanceof Uint8Array) return this.driver.put(key, data, options.contentType);
    return this.driver.put(key, new TextEncoder().encode(JSON.stringify(data)), options.contentType ?? "application/json");
  }

  async delete(key: string): Promise<void> {
    return this.driver.delete(key);
  }

  async list(prefix = ""): Promise<string[]> {
    return this.driver.list(prefix);
  }

  private get driver(): BlobDriver {
    this.driverInstance ??= createDriver(this.provider, this.bucket);
    return this.driverInstance;
  }
}

export function parseBlobUri(provider: BlobProvider, uri: string): string {
  const match = /^([a-z0-9]*):\/\/([^/]+)$/.exec(uri);
  if (!match) throw new Error(`Invalid blob URI "${uri}", expected "://name" or "${SCHEMES[provider]}://name"`);
  const [, scheme, name] = match;
  if (scheme && scheme !== SCHEMES[provider]) {
    throw new Error(`Blob URI "${uri}" uses scheme "${scheme}", provider "${provider}" expects "${SCHEMES[provider]}"`);
  }
  return name!;
}

export function blobEnvVar(name: string): string {
  return `CLOUDGEAR_BLOB_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function createDriver(provider: BlobProvider, bucket: string): BlobDriver {
  if (process.env.CLOUDGEAR_BLOB_DRIVER === "memory") return new MemoryBlobDriver();
  if (provider === "aws") return new S3BlobDriver(bucket);
  throw new Error(`BlobStore provider "${provider}" is not supported yet`);
}

export class MemoryBlobDriver implements BlobDriver {
  private readonly objects = new Map<string, Uint8Array>();

  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async put(key: string, data: Uint8Array) {
    this.objects.set(key, data);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list(prefix: string) {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
}

export class S3BlobDriver implements BlobDriver {
  constructor(
    private readonly bucket: string,
    private readonly client = new S3Client({}),
  ) {}

  async get(key: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.Body ? await res.Body.transformToByteArray() : new Uint8Array();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async put(key: string, data: Uint8Array, contentType?: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const object of res.Contents ?? []) if (object.Key) keys.push(object.Key);
      token = res.NextContinuationToken;
    } while (token);
    return keys;
  }

  async exists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === "NoSuchKey" || name === "NotFound";
}
