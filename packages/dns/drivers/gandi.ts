import { debug, errorSummary } from "@cloudgear/debug";
import { DEFAULT_TTL, quoteTxt, relativeName, withTrailingDot, type DnsDriver, type DnsRecord, type DnsRecordType } from "../driver";

const API = "https://api.gandi.net/v5/livedns";
// Bounds Gandi documents for rrset_ttl.
const MIN_TTL = 300;
const MAX_TTL = 2_592_000;

export interface GandiOptions {
  // A Gandi personal access token; defaults to $GANDI_TOKEN. $GANDI_API_KEY (legacy key) also works.
  token?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export class GandiDnsDriver implements DnsDriver {
  constructor(
    private readonly zone: string,
    private readonly options: GandiOptions = {},
  ) {}

  async upsert(record: DnsRecord) {
    await this.call("PUT", record.name, record.type, {
      rrset_values: record.values.map((value) => format(record.type, value)),
      rrset_ttl: Math.min(MAX_TTL, Math.max(MIN_TTL, record.ttl ?? DEFAULT_TTL)),
    });
  }

  async remove(name: string, type: DnsRecordType) {
    await this.call("DELETE", name, type, undefined, [404]);
  }

  async get(name: string, type: DnsRecordType): Promise<DnsRecord | null> {
    const res = await this.call("GET", name, type, undefined, [404]);
    if (res.status === 404) return null;
    const body = (await res.json()) as { rrset_values?: string[]; rrset_ttl?: number };
    return { name, type, values: body.rrset_values ?? [], ttl: body.rrset_ttl };
  }

  private async call(method: string, name: string, type: DnsRecordType, body?: unknown, tolerate: number[] = []) {
    const path = `/domains/${this.zone}/records/${relativeName(name, this.zone)}/${type}`;
    const started = performance.now();
    let res: Response;
    try {
      res = await (this.options.fetch ?? fetch)(`${API}${path}`, {
        method,
        headers: { ...this.auth(), "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      debug("gandi", `${method} ${path} failed (${Math.round(performance.now() - started)}ms): ${errorSummary(err)}`);
      throw err;
    }
    debug("gandi", `${method} ${path} -> ${res.status} (${Math.round(performance.now() - started)}ms)`, { tolerated: tolerate });
    if (!res.ok && !tolerate.includes(res.status)) {
      throw new Error(`Gandi ${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    return res;
  }

  private auth(): Record<string, string> {
    const token = this.options.token ?? process.env.GANDI_TOKEN;
    if (token) return { authorization: `Bearer ${token}` };
    const apiKey = this.options.apiKey ?? process.env.GANDI_API_KEY;
    if (apiKey) return { authorization: `Apikey ${apiKey}` };
    throw new Error("Gandi credentials missing: set GANDI_TOKEN (personal access token) or GANDI_API_KEY");
  }
}

function format(type: DnsRecordType, value: string): string {
  if (type === "CNAME") return withTrailingDot(value);
  if (type === "TXT") return quoteTxt(value);
  return value;
}

export const createGandiDriver = (zone: string, options: { token?: string } = {}): DnsDriver => new GandiDnsDriver(zone, { token: options.token });
