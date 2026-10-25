import type { CdnDriver, CdnInfo } from "../cdn-driver";

const sites = new Map<string, CdnInfo>();

export class MemoryCdnDriver implements CdnDriver {
  constructor(private readonly known = sites) {}

  async describe(domain: string): Promise<CdnInfo> {
    return this.known.get(domain) ?? { state: "none" };
  }

  set(domain: string, info: CdnInfo): void {
    this.known.set(domain, info);
  }
}

export function createMemoryCdnDriver(): MemoryCdnDriver {
  return new MemoryCdnDriver();
}
