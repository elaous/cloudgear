import {
  createDnsDriver,
  isWithinZone,
  normalizeHostname,
  normalizeRecordName,
  type DnsDriver,
  type DnsProvider,
  type DnsRecord,
  type DnsRecordType,
} from "./driver";

export { createDnsDriver, registerDnsDriver, normalizeHostname, normalizeRecordName, relativeName, isWithinZone } from "./driver";
export type { DnsDriver, DnsDriverFactory, DnsProvider, DnsRecord, DnsRecordType } from "./driver";

export interface DnsOptions {
  // The DNS zone holding the records; defaults to the last two labels of the domain.
  // Set it for registrations like example.co.uk.
  zone?: string;
  driver?: DnsDriver;
}

// The domain a site is served from, and the provider whose zone holds its records.
// Constructing it does nothing; `cloudgear apply` creates the records.
export class DNS {
  readonly domain: string;
  readonly zone: string;
  private driverPromise?: Promise<DnsDriver>;

  constructor(
    readonly provider: DnsProvider,
    domain: string,
    options: DnsOptions = {},
  ) {
    this.domain = normalizeHostname(domain);
    this.zone = normalizeHostname(options.zone ?? this.domain.split(".").slice(-2).join("."));
    if (!isWithinZone(this.domain, this.zone)) throw new Error(`Domain "${this.domain}" is not inside zone "${this.zone}"`);
    if (options.driver) this.driverPromise = Promise.resolve(options.driver);
  }

  async upsert(record: DnsRecord): Promise<void> {
    return (await this.driver()).upsert(this.checked(record));
  }

  async remove(name: string, type: DnsRecordType): Promise<void> {
    return (await this.driver()).remove(this.checkedName(name), type);
  }

  async get(name: string, type: DnsRecordType): Promise<DnsRecord | null> {
    return (await this.driver()).get(this.checkedName(name), type);
  }

  private checked(record: DnsRecord): DnsRecord {
    return { ...record, name: this.checkedName(record.name) };
  }

  private checkedName(name: string): string {
    const normalized = normalizeRecordName(name);
    if (!isWithinZone(normalized, this.zone)) throw new Error(`"${normalized}" is not inside zone "${this.zone}"`);
    return normalized;
  }

  private driver(): Promise<DnsDriver> {
    this.driverPromise ??= createDnsDriver(this.provider, this.zone).catch((err) => {
      this.driverPromise = undefined;
      throw err;
    });
    return this.driverPromise;
  }
}
