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
    const broken: DnsLookup = { records: async () => { throw new Error("timeout"); }, nameservers: async (zone) => { if (zone === ".") return ["root"]; throw new Error("timeout"); } };
    const check = await checkDns(plan(withCdn(), emptyState()), broken);
    expect(check.problems).toEqual([]);
    expect(check.unchecked.length).toBe(2);
  });

  test("nothing is checked when the plan has no endpoint changes", async () => {
    const check = await checkDns(plan(baseConfig({ function: [], resource: [], cdn: [], certificate: [] }), emptyState()), lookup({ "x": ["y"] }, { "example.com": [] }));
    expect(check).toEqual({ problems: [], unchecked: [] });
  });

  test("a sub-zone is delegated when a parent has name servers", async () => {
    const config = withCdn();
    config.certificate[0]!.dns.zone = "app.example.com";
    const check = await checkDns(plan(config, emptyState()), lookup({}, { "app.example.com": [] }));
    expect(check.problems).toEqual([]);
  });

  test("a wildcard record does not block a new host", async () => {
    const wild: DnsLookup = { records: async () => ["203.0.113.1"], nameservers: async () => ["ns1.example.net"] };
    const check = await checkDns(plan(withCdn(), emptyState()), wild);
    expect(check.problems).toEqual([]);
    expect(check.unchecked.join("\n")).toMatch(/wildcard record under example\.com/);
  });

  test("no answer from the resolver at all leaves everything unchecked", async () => {
    const dead: DnsLookup = { records: async () => [], nameservers: async () => [] };
    const check = await checkDns(plan(withCdn(), emptyState()), dead);
    expect(check.problems).toEqual([]);
    expect(check.unchecked.join("\n")).toMatch(/no DNS resolver answered/);
  });

  test("an API host that resolves is blocked too", async () => {
    const config = baseConfig({ function: [], resource: [], certificate: [{ provider: "aws", domain: "api.example.com", dns: { provider: "gandi", domain: "api.example.com", zone: "example.com" }, usage: "api" }], api: { provider: "aws", domain: "api.example.com", dns: { provider: "gandi", domain: "api.example.com", zone: "example.com" }, route: [] } as never });
    const check = await checkDns(plan(config, emptyState()), lookup({ "api.example.com": ["old.api.net"] }));
    expect(check.problems.join("\n")).toMatch(/api\.example\.com already resolves to old\.api\.net; creating its API/);
  });
});
