import { timed } from "@cloudgear/debug";
import {
  createDnsDriver,
  isWildcardDomain,
  isWithinZone,
  normalizeCertDomain,
  normalizeHostname,
  normalizeRecordName,
  type DnsDriver,
  type DnsProvider,
  type DnsRecord,
  type DnsRecordType,
} from "./driver";

export { createDnsDriver, registerDnsDriver, normalizeCertDomain, normalizeHostname, normalizeRecordName, relativeName, isWithinZone, isWildcardDomain, wildcardCovers } from "./driver";
export type { DnsDriver, DnsDriverFactory, DnsDriverOptions, DnsProvider, DnsRecord, DnsRecordType } from "./driver";

export interface DnsOptions {
  // Defaults to the last two labels; three for co.uk-style suffixes.
  zone?: string;
  // A secret from a SecretStore, never a literal.
  token?: TokenSource;
  driver?: DnsDriver;
}

export type TokenSource = string | { get(): Promise<string> };

// Second-level suffixes whose registrations span three labels.
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "ne", "or", "go"]);

function defaultZone(domain: string): string {
  const labels = domain.split(".");
  const second = labels.at(-2);
  const threeLabels = labels.length >= 3 && labels.at(-1)!.length === 2 && second !== undefined && SECOND_LEVEL.has(second);
  return labels.slice(threeLabels ? -3 : -2).join(".");
}

// Constructing does nothing; `cloudgear apply` creates the records.
export class DNS {
  readonly domain: string;
  readonly zone: string;
  private driverPromise?: Promise<DnsDriver>;
  private readonly token?: TokenSource;

  constructor(
    readonly provider: DnsProvider,
    domain: string,
    options: DnsOptions = {},
  ) {
    this.domain = normalizeCertDomain(domain);
    const base = isWildcardDomain(this.domain) ? this.domain.slice(2) : this.domain;
    this.zone = normalizeHostname(options.zone ?? defaultZone(base));
    if (!isWithinZone(base, this.zone)) throw new Error(`Domain "${this.domain}" is not inside zone "${this.zone}"`);
    this.token = options.token;
    if (options.driver) this.driverPromise = Promise.resolve(options.driver);
  }

  async upsert(record: DnsRecord): Promise<void> {
    const checked = this.checked(record);
    return timed("dns", `${this.provider} upsert ${checked.type} ${checked.name}`, async () => (await this.driver()).upsert(checked), {
      zone: this.zone,
      values: checked.values,
      ttl: checked.ttl,
    });
  }

  async remove(name: string, type: DnsRecordType): Promise<void> {
    const checked = this.checkedName(name);
    return timed("dns", `${this.provider} remove ${type} ${checked}`, async () => (await this.driver()).remove(checked, type), { zone: this.zone });
  }

  async get(name: string, type: DnsRecordType): Promise<DnsRecord | null> {
    const checked = this.checkedName(name);
    return timed("dns", `${this.provider} get ${type} ${checked}`, async () => (await this.driver()).get(checked, type), { zone: this.zone });
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
    this.driverPromise ??= (async () => {
      const token = typeof this.token === "string" || !this.token ? this.token : await this.token.get();
      return createDnsDriver(this.provider, this.zone, { token });
    })().catch((err) => {
      this.driverPromise = undefined;
      throw err;
    });
    return this.driverPromise;
  }
}
