import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { dumpDistributions, redactDistributionConfig } from "../src/dumpdistributions";

const distribution = { Id: "E1", ARN: "arn:aws:cloudfront::1:distribution/E1", DomainName: "d1.cloudfront.net", Status: "Deployed", Aliases: { Items: ["www.example.com"] } };
const live = {
  CallerReference: "ref",
  WebACLId: "arn:aws:wafv2:us-east-1:1:global/webacl/x/1",
  Origins: { Quantity: 1, Items: [{ Id: "o", DomainName: "origin.example.org", CustomHeaders: { Quantity: 1, Items: [{ HeaderName: "x-verify", HeaderValue: "secret-token" }] } }] },
};

const client = (pages: unknown[] = [{ DistributionList: { Items: [distribution] } }]) => {
  let page = 0;
  return {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      switch (command.constructor.name) {
        case "ListDistributionsCommand":
          return pages[page++];
        case "GetDistributionCommand":
          return { Distribution: distribution };
        case "GetDistributionConfigCommand":
          return { ETag: "e", DistributionConfig: live };
        default:
          throw new Error(`unexpected ${command.constructor.name}`);
      }
    },
  };
};

describe("dumping distributions", () => {
  let dir: string | undefined;
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));
  const target = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-dump-")));

  test("a distribution is written under its alias, with custom header values removed", async () => {
    const out = target();
    const result = await dumpDistributions(client(), ["www.example.com", "missing.example.com"], out);
    expect(result.missing).toEqual(["missing.example.com"]);
    expect(result.written).toEqual([path.join(out, "www.example.com.json")]);
    const written = JSON.parse(fs.readFileSync(result.written[0]!, "utf8"));
    expect(written).toMatchObject({ id: "E1", domain_name: "d1.cloudfront.net", status: "Deployed" });
    expect(written.config.WebACLId).toBe(live.WebACLId);
    expect(written.config.Origins.Items[0].CustomHeaders.Items[0]).toEqual({ HeaderName: "x-verify", HeaderValue: "<redacted>" });
    expect(JSON.stringify(written)).not.toContain("secret-token");
    expect(live.Origins.Items[0]!.CustomHeaders.Items[0]!.HeaderValue).toBe("secret-token");
  });

  test("all lists every aliased distribution across pages", async () => {
    const second = { ...distribution, Id: "E2", Aliases: { Items: ["api.example.com"] } };
    const out = target();
    const result = await dumpDistributions(client([{ DistributionList: { Items: [distribution], IsTruncated: true, NextMarker: "m" } }, { DistributionList: { Items: [second] } }]), "all", out);
    expect(result.written.map((f) => path.basename(f))).toEqual(["api.example.com.json", "www.example.com.json"]);
  });

  test("lookup is case-insensitive, finds later pages, skips items without aliases and writes each distribution once", async () => {
    const multi = { ...distribution, Id: "E2", Aliases: { Items: ["a.example.com", "b.example.com"] } };
    const out = target();
    const pages = [{ DistributionList: { Items: [{ ...distribution, Id: "E9", Aliases: undefined }], IsTruncated: true, NextMarker: "m" } }, { DistributionList: { Items: [multi] } }];
    const result = await dumpDistributions(client(pages), ["A.Example.com", "b.example.com"], out);
    expect(result.written.map((f) => path.basename(f))).toEqual(["a.example.com.json"]);
    expect(result.missing).toEqual([]);
  });

  test("an odd domain name cannot leave the directory", async () => {
    const out = target();
    const result = await dumpDistributions(client([{ DistributionList: { Items: [{ ...distribution, Aliases: { Items: ["../x", "*.example.com"] } }] } }]), ["../x", "*.example.com"], out);
    expect(result.written.length).toBe(1);
    expect(result.written.every((f) => path.dirname(f) === out)).toBe(true);
  });

  test("redaction leaves a config without custom headers alone", () => {
    expect(redactDistributionConfig({ Origins: { Items: [{ Id: "a" }] } })).toEqual({ Origins: { Items: [{ Id: "a" }] } });
  });
});
