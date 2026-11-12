import fs from "node:fs";
import path from "node:path";
import { GetDistributionCommand, GetDistributionConfigCommand, ListDistributionsCommand } from "@aws-sdk/client-cloudfront";
import type { SendClient } from "./deploy/aws/index";

export interface DumpResult {
  written: string[];
  missing: string[];
}

// Header values of custom origin headers are often secrets; the names are kept.
export function redactDistributionConfig(config: Record<string, any>): Record<string, any> {
  const copy = JSON.parse(JSON.stringify(config));
  for (const origin of copy.Origins?.Items ?? []) {
    for (const header of origin.CustomHeaders?.Items ?? []) header.HeaderValue = "<redacted>";
  }
  return copy;
}

// Writes each distribution's live config as JSON, found by its alias.
export async function dumpDistributions(client: SendClient, domains: string[] | "all", dir: string): Promise<DumpResult> {
  const byAlias = new Map<string, string>();
  let marker: string | undefined;
  do {
    const page = await client.send(new ListDistributionsCommand({ Marker: marker }));
    for (const item of page.DistributionList?.Items ?? []) {
      for (const alias of item.Aliases?.Items ?? []) byAlias.set(alias, item.Id);
    }
    marker = page.DistributionList?.IsTruncated ? page.DistributionList.NextMarker : undefined;
  } while (marker);

  const names = domains === "all" ? [...byAlias.keys()].sort() : domains.map((domain) => domain.toLowerCase());
  const seen = new Set<string>();
  const wanted = names.filter((name) => {
    const id = byAlias.get(name);
    const key = id ?? name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const result: DumpResult = { written: [], missing: [] };
  fs.mkdirSync(dir, { recursive: true });
  for (const domain of wanted) {
    const id = byAlias.get(domain);
    if (!id) {
      result.missing.push(domain);
      continue;
    }
    const [live, config] = await Promise.all([client.send(new GetDistributionCommand({ Id: id })), client.send(new GetDistributionConfigCommand({ Id: id }))]);
    const file = path.join(dir, `${domain.replace(/[^\w.-]/g, "_")}.json`);
    const body = { id, arn: live.Distribution?.ARN, domain_name: live.Distribution?.DomainName, status: live.Distribution?.Status, config: redactDistributionConfig(config.DistributionConfig ?? {}) };
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
    result.written.push(file);
  }
  return result;
}
