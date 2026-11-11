import { timed } from "@cloudgear/debug";
import {
  ChangeResourceRecordSetsCommand,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from "@aws-sdk/client-route-53";
import { DEFAULT_TTL, quoteTxt, withTrailingDot, type DnsDriver, type DnsRecord, type DnsRecordType } from "../driver";

interface SendClient {
  send(command: any): Promise<any>;
}

export class Route53DnsDriver implements DnsDriver {
  private zoneId?: Promise<string>;

  constructor(
    private readonly zone: string,
    private readonly client: SendClient = new Route53Client({}),
  ) {}

  async upsert(record: DnsRecord) {
    await this.change("UPSERT", {
      Name: withTrailingDot(record.name),
      Type: record.type,
      TTL: record.ttl ?? DEFAULT_TTL,
      ResourceRecords: record.values.map((value) => ({ Value: format(record.type, value) })),
    });
  }

  async remove(name: string, type: DnsRecordType) {
    const existing = await this.find(name, type);
    // DELETE repeats the record exactly as stored.
    if (existing) await this.change("DELETE", existing);
  }

  async get(name: string, type: DnsRecordType): Promise<DnsRecord | null> {
    const existing = await this.find(name, type);
    if (!existing) return null;
    return {
      name,
      type,
      values: (existing.ResourceRecords ?? []).map((r: { Value: string }) => r.Value),
      ttl: existing.TTL,
    };
  }

  private async find(name: string, type: DnsRecordType) {
    const fqdn = withTrailingDot(name);
    const res = await timed("route53", `list ${type} ${fqdn}`, async () =>
      this.client.send(
        new ListResourceRecordSetsCommand({
          HostedZoneId: await this.hostedZoneId(),
          StartRecordName: fqdn,
          StartRecordType: type,
          MaxItems: 1,
        }),
      ),
    );
    return (res.ResourceRecordSets ?? []).find(
      (set: { Name: string; Type: string }) => set.Name.replace(/\\052/g, "*") === fqdn && set.Type === type,
    );
  }

  private async change(action: "UPSERT" | "DELETE", recordSet: unknown) {
    await timed("route53", `${action} ${(recordSet as { Type?: string; Name?: string }).Type} ${(recordSet as { Name?: string }).Name}`, async () =>
      this.client.send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: await this.hostedZoneId(),
          ChangeBatch: { Changes: [{ Action: action, ResourceRecordSet: recordSet as never }] },
        }),
      ),
    );
  }

  private hostedZoneId(): Promise<string> {
    this.zoneId ??= this.client
      .send(new ListHostedZonesByNameCommand({ DNSName: this.zone, MaxItems: 5 }))
      .then((res) => {
        const zone = (res.HostedZones ?? []).find(
          (z: { Name: string; Config?: { PrivateZone?: boolean } }) => z.Name === withTrailingDot(this.zone) && !z.Config?.PrivateZone,
        );
        if (!zone) throw new Error(`No public Route 53 hosted zone named "${this.zone}"`);
        return String(zone.Id).replace("/hostedzone/", "");
      });
    this.zoneId.catch(() => (this.zoneId = undefined));
    return this.zoneId;
  }
}

function format(type: DnsRecordType, value: string): string {
  return type === "TXT" ? quoteTxt(value) : value;
}

export const createRoute53Driver = (zone: string): DnsDriver => new Route53DnsDriver(zone);
