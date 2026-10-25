import type { CertDriver, CertInfo } from "../cert-driver";

const certs = new Map<string, CertInfo>();

export class MemoryCertDriver implements CertDriver {
  constructor(private readonly known = certs) {}

  async describe(domain: string): Promise<CertInfo> {
    return this.known.get(domain) ?? { state: "none" };
  }

  set(domain: string, info: CertInfo): void {
    this.known.set(domain, info);
  }
}

export function createMemoryCertDriver(): MemoryCertDriver {
  return new MemoryCertDriver();
}
