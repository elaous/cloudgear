import type { BlobStore, ProviderOptions } from "@cloudgear/blob";
import { isWildcardDomain, normalizeHostname, wildcardCovers, type DNS } from "@cloudgear/dns";
import { debug, timed } from "@cloudgear/debug";
import fs from "node:fs";
import path from "node:path";
import { createCdnDriver, type CdnDriver, type CdnInfo, type CdnProvider } from "./cdn-driver";
import { createCertDriver, type CertDriver, type CertInfo, type CertProvider } from "./cert-driver";

export type { ProviderOptions };
export { createCertDriver, registerCertDriver } from "./cert-driver";
export type { CertDriver, CertDriverFactory, CertDriverOptions, CertInfo, CertProvider, CertState } from "./cert-driver";

export { createCdnDriver, registerCdnDriver } from "./cdn-driver";
export type { CdnDriver, CdnDriverFactory, CdnInfo, CdnProvider, CdnState } from "./cdn-driver";

export interface CertOptions {
  // Literal only; default differs for CDN and router.
  region?: string;
  // Literals only; read by generate.
  options?: ProviderOptions;
  driver?: CertDriver;
}

export class Cert {
  private driverPromise?: Promise<CertDriver>;
  readonly region: string | undefined;

  constructor(
    readonly provider: CertProvider,
    readonly dns: DNS,
    options: CertOptions = {},
  ) {
    assertCertProvider(provider);
    this.region = options.region;
    if (options.driver) this.driverPromise = Promise.resolve(options.driver);
  }

  get domain(): string {
    return this.dns.domain;
  }

  async status(): Promise<CertInfo> {
    return timed("cert", `status ${this.domain}`, async () => (await this.driver()).describe(this.domain), { region: this.region });
  }

  private driver(): Promise<CertDriver> {
    this.driverPromise ??= createCertDriver(this.provider, { region: this.region }).catch((err) => {
      this.driverPromise = undefined;
      throw err;
    });
    return this.driverPromise;
  }
}

export interface RouteFetchInit {
  method?: string;
  headers?: Record<string, string> | Headers;
  body?: unknown;
  query?: Record<string, string | number | boolean> | URLSearchParams | string;
  params?: Record<string, string | number>;
}

// Satisfied by FunctionRouter from @cloudgear/functions.
export interface CdnRouter {
  readonly provider: string;
  fetchVia?(base: string, input: string, init?: RequestInit | RouteFetchInit): Promise<Response>;
}

// Where CloudFront serves from: 100 is North America and Europe, 200 adds Asia, Middle East and Africa, All every location.
export type PriceClass = "PriceClass_100" | "PriceClass_200" | "PriceClass_All";

export interface CdnOptions {
  // Exactly one of `bucket` and `router`.
  bucket?: BlobStore;
  router?: CdnRouter;
  // Hostname on a wildcard Cert; literal only.
  domain?: string;
  // Runs a CloudFront Function per request; literal only.
  methodRouting?: "function";
  // `true` keeps the web ACL the distribution has; or a WAFv2 web ACL ARN in us-east-1. Literal only.
  webAcl?: true | string;
  // Literal only; the same as options.price_class.
  priceClass?: PriceClass;
  options?: ProviderOptions;
  driver?: CdnDriver;
}

// Does nothing at runtime; reports what `cloudgear apply` deployed.
export class CDN {
  private driverPromise?: Promise<CdnDriver>;

  constructor(
    readonly provider: CdnProvider,
    readonly cert: Cert,
    readonly options: CdnOptions,
  ) {
    assertProvider(provider);
    if (cert.provider !== provider) {
      throw new Error(`The CDN uses provider "${provider}" but its certificate uses "${cert.provider}"`);
    }
    if (!options.bucket === !options.router) {
      throw new Error("A CDN serves either a bucket or a router: give exactly one of `bucket` and `router`");
    }
    if (options.bucket && options.bucket.provider !== provider) {
      throw new Error(`The CDN uses provider "${provider}" but its bucket uses "${options.bucket.provider}"`);
    }
    if (options.router && options.router.provider !== provider) {
      throw new Error(`The CDN uses provider "${provider}" but its router uses "${options.router.provider}"`);
    }
    if (options.methodRouting && !options.router) {
      throw new Error("methodRouting only applies to a CDN that serves a router");
    }
    if (isWildcardDomain(cert.domain)) {
      if (!options.domain) throw new Error(`The Cert is for "${cert.domain}", so the CDN needs the hostname it serves: { domain: "files${cert.domain.slice(1)}" }`);
      const host = normalizeHostname(options.domain);
      if (!wildcardCovers(cert.domain, host)) throw new Error(`"${host}" is not covered by "${cert.domain}": a wildcard covers exactly one label`);
    } else if (options.domain !== undefined && normalizeHostname(options.domain) !== cert.domain) {
      throw new Error(`The CDN's domain "${options.domain}" is not the Cert's "${cert.domain}"; use a wildcard Cert to serve other hostnames`);
    }
    if (options.driver) this.driverPromise = Promise.resolve(options.driver);
  }

  get domain(): string {
    return this.options.domain ? normalizeHostname(this.options.domain) : this.cert.domain;
  }

  // Throws until the CDN is deployed.
  async url(): Promise<string> {
    const deployed = readDeployedCdn(this.domain);
    debug("cdn", `url ${this.domain} ${deployed ? "from the endpoints file" : "not in the endpoints file"}`, { url: deployed });
    if (deployed) return deployed;
    const info = await this.status();
    if (!info.url) throw new Error(`The CDN for "${this.domain}" is not deployed; run cloudgear apply`);
    return info.url;
  }

  // Route name or path; object path for a bucket.
  async fetch(input: string, init?: RequestInit | RouteFetchInit): Promise<Response> {
    const { router } = this.options;
    if (router && typeof router.fetchVia !== "function") throw new Error("The CDN's router has no fetchVia; pass a FunctionRouter");
    const base = await this.url();
    if (router) return router.fetchVia!(base, input, init);
    return this.fetchObject(trimTrailingSlashes(base), input, init as RequestInit | undefined);
  }

  private async fetchObject(base: string, input: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new Error(`A CDN serving a bucket is read-only: ${method} is not allowed, use GET or HEAD`);
    if (init.body !== undefined && init.body !== null) throw new Error(`A ${method} request cannot have a body`);
    const target = objectPath(input);
    debug("cdn", `fetch ${method} ${this.domain}`);
    return fetch(`${base}${target}`, { redirect: "manual", ...init, method });
  }

  async status(): Promise<CdnInfo> {
    return timed("cdn", `status ${this.domain}`, async () => (await this.driver()).describe(this.domain));
  }

  private driver(): Promise<CdnDriver> {
    this.driverPromise ??= createCdnDriver(this.provider).catch((err) => {
      this.driverPromise = undefined;
      throw err;
    });
    return this.driverPromise;
  }
}

const ABSOLUTE_INPUT = /^(?:[a-z][a-z\d+.-]*:\/\/|\/\/|\\\\)/i;
const OBJECT_ORIGIN = "http://cdn.invalid";
const PARENT_SEGMENT = /^(?:\.|%2e){2}$/i;

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

function objectPath(given: string): string {
  const input = given.replace(/[\t\r\n]/g, "");
  const message = `fetch takes an object path, got "${given}"; the CDN owns the host`;
  if (ABSOLUTE_INPUT.test(input)) throw new Error(message);
  const rooted = input.startsWith("/") ? input : `/${input}`;
  let depth = 0;
  for (const segment of rooted.split(/[?#]/, 1)[0]!.split(/[/\\]/)) {
    if (PARENT_SEGMENT.test(segment)) {
      if (--depth < 0) throw new Error(`"${given}" leaves the CDN's root`);
    } else if (segment && !/^(?:\.|%2e)$/i.test(segment)) depth++;
  }
  const parsed = new URL(rooted, OBJECT_ORIGIN);
  if (parsed.origin !== OBJECT_ORIGIN) throw new Error(message);
  return `${parsed.pathname}${parsed.search}`;
}

// Stops at the nearest package.json, like the router's endpoints lookup.
function readDeployedCdn(domain: string): string | undefined {
  const file = process.env.CLOUDGEAR_ENDPOINTS_FILE ?? findUp(process.cwd(), ".cloudgear/endpoints.json");
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { cdn?: { domain?: string; url?: string }; cdns?: Record<string, { url?: string }>; api?: { domain?: string; url?: string; via?: string } };
    const own = parsed.cdns?.[domain];
    if (own?.url) return own.url;
    if (parsed.cdn?.domain === domain && parsed.cdn.url) return parsed.cdn.url;
    return servesRouter(parsed.api, domain) ? `https://${domain}` : undefined;
  } catch {
    return undefined;
  }
}

// Same test as the router's: `via`, or a distribution URL for older files.
function servesRouter(api: { domain?: string; url?: string; via?: string } | undefined, domain: string): boolean {
  if (!api?.domain || normalizeHostname(api.domain) !== domain) return false;
  if (api.via === "cloudfront") return true;
  try {
    return !!api.url && /\.cloudfront\.net$/i.test(new URL(api.url).hostname);
  } catch {
    return false;
  }
}

function findUp(dir: string, relativeFile: string): string | undefined {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const candidate = path.join(current, relativeFile);
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(current, "package.json")) || path.dirname(current) === current) return undefined;
  }
}

function assertCertProvider(provider: string): void {
  if (provider !== "aws") throw new Error(`Certificate provider "${provider}" is not supported yet (supported: aws)`);
}

function assertProvider(provider: string): void {
  if (provider !== "aws") throw new Error(`CDN provider "${provider}" is not supported yet (supported: aws)`);
}
