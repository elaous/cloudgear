import { CACHE_ENGINES as ENGINES, CACHE_PROVIDERS as PROVIDERS, CACHE_SIZES as SIZES } from "./schema.gen";

export { CACHE_DEFAULTS } from "./schema.gen";

export type CacheProvider = (typeof PROVIDERS)[number];
export type CacheEngine = (typeof ENGINES)[number];
export type CacheSize = (typeof SIZES)[number];

export const CACHE_PROVIDERS: readonly CacheProvider[] = PROVIDERS;
export const CACHE_ENGINES: readonly CacheEngine[] = ENGINES;
export const CACHE_SIZES: readonly CacheSize[] = SIZES;

export interface CacheOptions {
  // Default "valkey"; "redis" and "valkey" speak the same protocol.
  engine?: CacheEngine;
  // One node: "micro", "small" or "medium"; default "micro".
  size?: CacheSize;
  // A Network (see @cloudgear/network); omit it for the default VPC.
  network?: { readonly provider: string };
  // Without it, `cloudgear destroy` refuses to delete the cache and its data.
  allowDestroy?: boolean;
}

const CACHE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,38}$/;

export function assertCacheName(name: string): void {
  if (!CACHE_NAME.test(name)) throw new Error(`Invalid cache name "${name}"; start with a letter and use up to 39 letters, digits, "_" or "-"`);
}

// Constructing does nothing; `cloudgear apply` creates or adopts the cache.
export class Cache {
  constructor(
    readonly provider: CacheProvider,
    readonly name: string,
    readonly options: CacheOptions = {},
  ) {
    if (!CACHE_PROVIDERS.includes(provider)) throw new Error(`Cache provider "${provider}" is not supported yet (supported: ${CACHE_PROVIDERS.join(", ")})`);
    assertCacheName(name);
    if (options.engine !== undefined && !CACHE_ENGINES.includes(options.engine)) throw new Error(`Unsupported cache engine "${options.engine}" (supported: ${CACHE_ENGINES.join(", ")})`);
    if (options.size !== undefined && !CACHE_SIZES.includes(options.size)) throw new Error(`Unsupported cache size "${options.size}" (supported: ${CACHE_SIZES.join(", ")})`);
  }

  static envVarFor(name: string): string {
    return `CLOUDGEAR_CACHE_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  }

  // "host:port"; set by cloudgear in functions that use the cache, so set it yourself to run locally.
  get location(): string {
    const value = process.env[Cache.envVarFor(this.name)];
    if (!value) throw new Error(`${Cache.envVarFor(this.name)} is not set; cloudgear sets it in deployed functions that use cache "${this.name}"`);
    return value;
  }

  get host(): string {
    return this.location.slice(0, this.location.lastIndexOf(":"));
  }

  get port(): number {
    return Number(this.location.slice(this.location.lastIndexOf(":") + 1));
  }
}
