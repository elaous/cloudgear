export type DnsProvider = "gandi" | "aws";
export type DnsRecordType = "CNAME" | "TXT" | "A" | "AAAA";

export interface DnsRecord {
  // Fully qualified, without a trailing dot, e.g. "cdn.example.com".
  name: string;
  type: DnsRecordType;
  values: string[];
  ttl?: number;
}

export interface DnsDriver {
  upsert(record: DnsRecord): Promise<void>;
  // Removing a record that does not exist is not an error.
  remove(name: string, type: DnsRecordType): Promise<void>;
  get(name: string, type: DnsRecordType): Promise<DnsRecord | null>;
}

export type DnsDriverFactory = (zone: string) => DnsDriver | Promise<DnsDriver>;

export const DEFAULT_TTL = 300;

const factories = new Map<DnsProvider, DnsDriverFactory>();

const BUILT_IN: Record<DnsProvider, () => Promise<DnsDriverFactory>> = {
  gandi: async () => (await import("./drivers/gandi")).createGandiDriver,
  aws: async () => (await import("./drivers/route53")).createRoute53Driver,
};

export function registerDnsDriver(provider: DnsProvider, factory: DnsDriverFactory): void {
  factories.set(provider, factory);
}

export async function createDnsDriver(provider: DnsProvider, zone: string): Promise<DnsDriver> {
  if (process.env.CLOUDGEAR_DNS_DRIVER === "memory") return (await import("./drivers/memory")).createMemoryDriver(zone);
  let factory = factories.get(provider);
  if (!factory) {
    const load = BUILT_IN[provider];
    if (!load) throw new Error(`No DNS driver for provider "${provider}"; register one with registerDnsDriver()`);
    factory = await load();
    factories.set(provider, factory);
  }
  return factory(zone);
}

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function normalizeHostname(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME.test(normalized) || normalized.length > 253) throw new Error(`Invalid domain name "${name}"`);
  return normalized;
}

// Record names may start labels with "_" (ACM validation records do); site domains may not.
const RECORD_NAME = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function normalizeRecordName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/\.$/, "");
  if (!RECORD_NAME.test(normalized) || normalized.length > 253) throw new Error(`Invalid record name "${name}"`);
  return normalized;
}

export function isWithinZone(name: string, zone: string): boolean {
  return name === zone || name.endsWith(`.${zone}`);
}

// Name of a record relative to its zone ("@" for the zone itself).
export function relativeName(name: string, zone: string): string {
  if (name === zone) return "@";
  if (!isWithinZone(name, zone)) throw new Error(`"${name}" is not inside zone "${zone}"`);
  return name.slice(0, -(zone.length + 1));
}

export function withTrailingDot(value: string): string {
  return value.endsWith(".") ? value : `${value}.`;
}

export function quoteTxt(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value : `"${value.replace(/"/g, '\\"')}"`;
}
