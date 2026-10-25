export type CertProvider = "aws";
export type CertState = "none" | "pending" | "issued" | "failed";

export interface CertInfo {
  state: CertState;
  // Provider identifier of the certificate (the ARN on AWS) when one exists.
  id?: string;
}

export interface CertDriver {
  // The newest certificate issued for exactly this domain.
  describe(domain: string): Promise<CertInfo>;
}

export interface CertDriverOptions {
  region?: string;
}

export type CertDriverFactory = (options: CertDriverOptions) => CertDriver | Promise<CertDriver>;

const factories = new Map<CertProvider, CertDriverFactory>();

const BUILT_IN: Record<CertProvider, () => Promise<CertDriverFactory>> = {
  aws: async () => (await import("./drivers/acm")).createAcmDriver,
};

export function registerCertDriver(provider: CertProvider, factory: CertDriverFactory): void {
  factories.set(provider, factory);
}

export async function createCertDriver(provider: CertProvider, options: CertDriverOptions = {}): Promise<CertDriver> {
  if (process.env.CLOUDGEAR_CERT_DRIVER === "memory") return (await import("./drivers/memory")).createMemoryCertDriver();
  let factory = factories.get(provider);
  if (!factory) {
    const load = BUILT_IN[provider];
    if (!load) throw new Error(`No certificate driver for provider "${provider}"; register one with registerCertDriver()`);
    factory = await load();
    factories.set(provider, factory);
  }
  return factory(options);
}
