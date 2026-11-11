import { Resolver } from "node:dns/promises";
import type { PlannedAction } from "./deploy/plan";

export interface DnsLookup {
  // Resolves to the names or addresses a host currently answers with; [] when it has no records.
  records(host: string): Promise<string[]>;
  nameservers(zone: string): Promise<string[]>;
}

export interface DnsCheck {
  problems: string[];
  unchecked: string[];
}

const NO_RECORDS = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN", "ENOTIMP"]);

export function systemLookup(server?: string): DnsLookup {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  if (server) resolver.setServers([server]);
  const attempt = async (run: () => Promise<string[]>): Promise<string[]> => {
    try {
      return await run();
    } catch (err) {
      if (NO_RECORDS.has((err as { code?: string }).code ?? "")) return [];
      throw err;
    }
  };
  return {
    async records(host) {
      const found = await Promise.all([attempt(() => resolver.resolveCname(host)), attempt(() => resolver.resolve4(host)), attempt(() => resolver.resolve6(host))]);
      return found.flat();
    },
    nameservers: (zone) => attempt(() => resolver.resolveNs(zone)),
  };
}

const ENDPOINTS = new Set(["@aws.CloudFront", "@aws.ApiGateway"]);
const DNS_TYPES = new Set([...ENDPOINTS, "@aws.Certificate"]);

// Looks only at what the plan is about to create or change; destroys are not checked.
export async function checkDns(actions: PlannedAction[], lookup: DnsLookup): Promise<DnsCheck> {
  const result: DnsCheck = { problems: [], unchecked: [] };
  const zones = new Set<string>();
  const hosts = new Map<string, string>();
  for (const action of actions) {
    if (!action.desired || !DNS_TYPES.has(action.type) || (action.op !== "create" && action.op !== "update")) continue;
    const spec = action.desired.spec as { domain?: string; dns_zone?: string };
    if (spec.dns_zone) zones.add(spec.dns_zone);
    if (action.op === "create" && ENDPOINTS.has(action.type) && spec.domain) hosts.set(spec.domain, action.type);
  }
  const zoneResults = await Promise.all(
    [...zones].sort().map(async (zone) => {
      try {
        return (await lookup.nameservers(zone)).length ? undefined : { problem: `the zone ${zone} has no name servers in public DNS; it is not delegated, so records written to it will not resolve` };
      } catch (err) {
        return { unchecked: `could not look up the name servers of ${zone} (${(err as Error).message})` };
      }
    }),
  );
  const hostResults = await Promise.all(
    [...hosts].sort().map(async ([host, type]) => {
      try {
        const found = await lookup.records(host);
        return found.length ? { problem: `${host} already resolves to ${found.join(", ")}; creating its ${type === "@aws.ApiGateway" ? "API" : "CDN"} would fail or take over the name. Import the existing resource, or remove the record` } : undefined;
      } catch (err) {
        return { unchecked: `could not look up ${host} (${(err as Error).message})` };
      }
    }),
  );
  for (const item of [...zoneResults, ...hostResults]) {
    if (item?.problem) result.problems.push(item.problem);
    if (item?.unchecked) result.unchecked.push(item.unchecked);
  }
  return result;
}

export function formatDnsCheck(check: DnsCheck): string {
  return [...check.problems.map((p) => `  - ${p}`), ...check.unchecked.map((u) => `  (unchecked) ${u}`)].join("\n");
}
