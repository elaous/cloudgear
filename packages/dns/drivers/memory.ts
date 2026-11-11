import type { DnsDriver, DnsRecord, DnsRecordType } from "../driver";

const zones = new Map<string, Map<string, DnsRecord>>();

export class MemoryDnsDriver implements DnsDriver {
  constructor(private readonly records = new Map<string, DnsRecord>()) {}

  async upsert(record: DnsRecord) {
    this.records.set(`${record.type} ${record.name}`, { ...record, values: [...record.values] });
  }
  async remove(name: string, type: DnsRecordType) {
    this.records.delete(`${type} ${name}`);
  }
  async get(name: string, type: DnsRecordType) {
    return this.records.get(`${type} ${name}`) ?? null;
  }
}

// Same zone name shares records across driver instances.
export function createMemoryDriver(zone: string): DnsDriver {
  let records = zones.get(zone);
  if (!records) {
    records = new Map();
    zones.set(zone, records);
  }
  return new MemoryDnsDriver(records);
}
