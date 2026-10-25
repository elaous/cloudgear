import type { BlobStore } from "@cloudgear/blob";
import type { DNS } from "@cloudgear/dns";

export type CdnProvider = "aws";

// A TLS certificate for `dns.domain`, validated through `dns`. Constructing it does nothing;
// `cloudgear apply` requests the certificate and writes the validation record.
export class Cert {
  constructor(
    readonly provider: CdnProvider,
    readonly dns: DNS,
  ) {
    assertProvider(provider);
  }

  get domain(): string {
    return this.dns.domain;
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

function assertProvider(provider: string): void {
  if (provider !== "aws") throw new Error(`CDN provider "${provider}" is not supported yet (supported: aws)`);
}
