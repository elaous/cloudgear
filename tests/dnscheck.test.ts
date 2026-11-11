import { describe, expect, test } from "bun:test";
import { checkDns, type DnsLookup } from "../src/dnscheck";
import { plan } from "../src/deploy/plan";
import { baseConfig, emptyState } from "./helpers";

const lookup = (records: Record<string, string[]>, ns: Record<string, string[]> = {}): DnsLookup => ({
  records: async (host) => records[host] ?? [],
  nameservers: async (zone) => ns[zone] ?? ["ns1.example.net"],
});

const dnsSpec = { provider: "gandi", domain: "www.example.com", zone: "example.com" };
const withCdn = () =>
  baseConfig({
    resource: [{ name: "web", type: "@aws.S3", physical_name: "my-web", dry: false, source: "a.ts:1" }],
    function: [],
    certificate: [{ provider: "aws", domain: "www.example.com", dns: dnsSpec, usage: "cdn" }],
    cdn: [{ provider: "aws", domain: "www.example.com", bucket: "web", path: "" }],
  });

describe("the DNS check", () => {
  test("passes when the zone is delegated and the host is free", async () => {
    const check = await checkDns(plan(withCdn(), emptyState()), lookup({}));
    expect(check).toEqual({ problems: [], unchecked: [] });
  });

  test("blocks a CDN host that already resolves", async () => {
    const check = await checkDns(plan(withCdn(), emptyState()), lookup({ "www.example.com": ["old.cdn.net"] }));
    expect(check.problems.join("\n")).toMatch(/www\.example\.com already resolves to old\.cdn\.net/);
  });

  test("blocks a zone with no name servers", async () => {
    const check = await checkDns(plan(withCdn(), emptyState()), lookup({}, { "example.com": [] }));
    expect(check.problems.join("\n")).toMatch(/zone example\.com has no name servers/);
  });

  test("a failing lookup is unchecked, not a problem", async () => {
    const broken: DnsLookup = { records: async () => { throw new Error("timeout"); }, nameservers: async () => { throw new Error("timeout"); } };
    const check = await checkDns(plan(withCdn(), emptyState()), broken);
    expect(check.problems).toEqual([]);
    expect(check.unchecked.length).toBe(2);
  });

  test("nothing is checked when the plan has no endpoint changes", async () => {
    const check = await checkDns(plan(baseConfig({ function: [], resource: [], cdn: [], certificate: [] }), emptyState()), lookup({ "x": ["y"] }, { "example.com": [] }));
    expect(check).toEqual({ problems: [], unchecked: [] });
  });
});
