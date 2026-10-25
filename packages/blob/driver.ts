export type BlobProvider = "aws" | "gcp" | "azure";
export type BlobData = string | Uint8Array;

export interface BlobDriver {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  exists(key: string): Promise<boolean>;
}

export interface BlobDriverOptions {
  // Where the store lives, when it is not the provider's default region.
  region?: string;
}

export type BlobDriverFactory = (location: string, options: BlobDriverOptions) => BlobDriver | Promise<BlobDriver>;

export const URI_SCHEMES: Record<BlobProvider, string> = { aws: "s3", gcp: "gs", azure: "az" };

const factories = new Map<BlobProvider, BlobDriverFactory>();

const BUILT_IN: Partial<Record<BlobProvider, () => Promise<BlobDriverFactory>>> = {
  aws: async () => (await import("./drivers/s3")).createS3Driver,
};

export function registerBlobDriver(provider: BlobProvider, factory: BlobDriverFactory): void {
  factories.set(provider, factory);
}

export async function createBlobDriver(provider: BlobProvider, location: string, options: BlobDriverOptions = {}): Promise<BlobDriver> {
  if (process.env.CLOUDGEAR_BLOB_DRIVER === "memory") {
    return (await import("./drivers/memory")).createMemoryDriver(location);
  }
  let factory = factories.get(provider);
  if (!factory) {
    const load = BUILT_IN[provider];
    if (!load) throw new Error(`No blob driver for provider "${provider}"; register one with registerBlobDriver()`);
    factory = await load();
    factories.set(provider, factory);
  }
  return factory(location, options);
}

export function parseBlobUri(provider: BlobProvider, uri: string): string {
  const match = /^([a-z0-9]*):\/\/([^/]+)$/.exec(uri);
  if (!match) throw new Error(`Invalid blob URI "${uri}", expected "://name" or "${URI_SCHEMES[provider]}://name"`);
  const [, scheme, name] = match;
  if (scheme && scheme !== URI_SCHEMES[provider]) {
    throw new Error(`Blob URI "${uri}" uses scheme "${scheme}", provider "${provider}" expects "${URI_SCHEMES[provider]}"`);
  }
  return name!;
}
