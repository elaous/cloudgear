export type CdnProvider = "aws";
export type CdnState = "none" | "deploying" | "deployed";

export interface CdnInfo {
  state: CdnState;
  id?: string;
  url?: string;
}

export interface CdnDriver {
  describe(domain: string): Promise<CdnInfo>;
}

export type CdnDriverFactory = () => CdnDriver | Promise<CdnDriver>;

const factories = new Map<CdnProvider, CdnDriverFactory>();

const BUILT_IN: Record<CdnProvider, () => Promise<CdnDriverFactory>> = {
  aws: async () => (await import("./drivers/cloudfront")).createCloudFrontDriver,
};

export function registerCdnDriver(provider: CdnProvider, factory: CdnDriverFactory): void {
  factories.set(provider, factory);
}

export async function createCdnDriver(provider: CdnProvider): Promise<CdnDriver> {
  if (process.env.CLOUDGEAR_CDN_DRIVER === "memory") return (await import("./drivers/memory-cdn")).createMemoryCdnDriver();
  let factory = factories.get(provider);
  if (!factory) {
    const load = BUILT_IN[provider];
    if (!load) throw new Error(`No CDN driver for provider "${provider}"; register one with registerCdnDriver()`);
    factory = await load();
    factories.set(provider, factory);
  }
  return factory();
}
