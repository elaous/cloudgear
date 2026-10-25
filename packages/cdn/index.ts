import type { BlobStore } from "@cloudgear/blob";
import type { DNS } from "@cloudgear/dns";
import fs from "node:fs";
import path from "node:path";
import { createCdnDriver, type CdnDriver, type CdnInfo, type CdnProvider } from "./cdn-driver";
import { createCertDriver, type CertDriver, type CertInfo, type CertProvider } from "./cert-driver";

export { createCertDriver, registerCertDriver } from "./cert-driver";
export type { CertDriver, CertDriverFactory, CertDriverOptions, CertInfo, CertProvider, CertState } from "./cert-driver";

export { createCdnDriver, registerCdnDriver } from "./cdn-driver";
export type { CdnDriver, CdnDriverFactory, CdnInfo, CdnProvider, CdnState } from "./cdn-driver";

export type ProviderOptions = Record<string, string | number | boolean>;

export interface CertOptions {
  // Provider settings with no dedicated option; MUST be literals.
  options?: ProviderOptions;
  driver?: CertDriver;
}

// A TLS certificate for `dns.domain`, validated through `dns`; it needs no CDN. Constructing it does
// nothing; `cloudgear apply` requests the certificate and writes the validation record. On AWS the
// certificate lives in AWS Certificate Manager.
export class Cert {
  private driverPromise?: Promise<CertDriver>;

  constructor(
    readonly provider: CertProvider,
    readonly dns: DNS,
    options: CertOptions = {},
  ) {
    assertCertProvider(provider);
    if (options.driver) this.driverPromise = Promise.resolve(options.driver);
  }

  get domain(): string {
    return this.dns.domain;
  }

  // State of the deployed certificate: "none" until `cloudgear apply` has requested it.
  async status(): Promise<CertInfo> {
    return (await this.driver()).describe(this.domain);
  }

  private driver(): Promise<CertDriver> {
    this.driverPromise ??= createCertDriver(this.provider).catch((err) => {
      this.driverPromise = undefined;
      throw err;
    });
    return this.driverPromise;
  }
}

export interface CdnOptions {
  cert: Cert;
  // The static site: served at "/" from this store's bucket (and path prefix, if it has one).
  bucket: BlobStore;
  options?: ProviderOptions;
  driver?: CdnDriver;
}

// A CDN serving `dns.domain`: the bucket's files by default, and, when handed to
// `new FunctionRouter(provider, { cdn })`, the router's routes from the same domain.
// Like DNS and Cert it does nothing at runtime except report what `cloudgear apply` deployed.
export class CDN {
  private driverPromise?: Promise<CdnDriver>;

  constructor(
    readonly provider: CdnProvider,
    readonly dns: DNS,
    readonly options: CdnOptions,
  ) {
    assertProvider(provider);
    if (options.cert.domain !== dns.domain) {
      throw new Error(`The certificate covers "${options.cert.domain}" but the CDN serves "${dns.domain}"`);
    }
    if (options.bucket.provider !== provider) {
      throw new Error(`The CDN uses provider "${provider}" but its bucket uses "${options.bucket.provider}"`);
    }
    if (options.driver) this.driverPromise = Promise.resolve(options.driver);
  }

  get domain(): string {
    return this.dns.domain;
  }

  // The distribution's own URL: from the endpoints file `cloudgear apply` wrote, else from the
  // provider. Throws until the CDN has been deployed.
  async url(): Promise<string> {
    const deployed = readDeployedCdn(this.domain);
    if (deployed) return deployed;
    const info = await this.status();
    if (!info.url) throw new Error(`The CDN for "${this.domain}" is not deployed; run cloudgear apply`);
    return info.url;
  }

  // Live state of the distribution from the provider: "none" until deployed.
  async status(): Promise<CdnInfo> {
    return (await this.driver()).describe(this.domain);
  }

  private driver(): Promise<CdnDriver> {
    this.driverPromise ??= createCdnDriver(this.provider).catch((err) => {
      this.driverPromise = undefined;
      throw err;
    });
    return this.driverPromise;
  }
}

// Stops at the nearest package.json, like the router's endpoints lookup.
function readDeployedCdn(domain: string): string | undefined {
  const file = process.env.CLOUDGEAR_ENDPOINTS_FILE ?? findUp(process.cwd(), ".cloudgear/endpoints.json");
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const cdn = (JSON.parse(fs.readFileSync(file, "utf8")) as { cdn?: { domain?: string; url?: string } }).cdn;
    return cdn?.domain === domain && cdn.url ? cdn.url : undefined;
  } catch {
    return undefined;
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
