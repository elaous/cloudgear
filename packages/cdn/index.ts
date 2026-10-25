import type { BlobStore } from "@cloudgear/blob";
import type { DNS } from "@cloudgear/dns";
import { createCertDriver, type CertDriver, type CertInfo, type CertProvider } from "./cert-driver";

export { createCertDriver, registerCertDriver } from "./cert-driver";
export type { CertDriver, CertDriverFactory, CertDriverOptions, CertInfo, CertProvider, CertState } from "./cert-driver";

export type CdnProvider = "aws";

export interface CertOptions {
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
}

// A CDN serving `dns.domain`: the bucket's files by default, and, when handed to
// `new FunctionRouter(provider, { cdn })`, the router's routes from the same domain.
export class CDN {
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
  }

  get domain(): string {
    return this.dns.domain;
  }

  get url(): string {
    return `https://${this.domain}`;
  }
}

function assertCertProvider(provider: string): void {
  if (provider !== "aws") throw new Error(`Certificate provider "${provider}" is not supported yet (supported: aws)`);
}

function assertProvider(provider: string): void {
  if (provider !== "aws") throw new Error(`CDN provider "${provider}" is not supported yet (supported: aws)`);
}
