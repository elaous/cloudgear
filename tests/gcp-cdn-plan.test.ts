import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { CloudgearConfig } from "../src/config/schema";
import { generate } from "../src/generate";
import { apply } from "../src/deploy/apply";
import { plan } from "../src/deploy/plan";
import { CDN, Cert } from "@cloudgear/cdn";
import { DNS } from "@cloudgear/dns";
import { baseConfig, emptyState } from "./helpers";

const DOMAIN = "cdn.example.com";
const dns = { provider: "gandi", domain: DOMAIN, zone: "example.com" };

const config = (bucketOptions: Record<string, string> | undefined = { public_read: "true", project: "my-proj-123" }, overrides: Partial<CloudgearConfig> = {}): CloudgearConfig => ({
  ...baseConfig({ provider: "gcp", function: [] }),
  resource: [{ name: "site", type: "@gcp.GCS", physical_name: "site", dry: false, source: "setup.ts:1", ...(bucketOptions ? { options: bucketOptions } : {}) }],
  certificate: [{ provider: "gcp", domain: DOMAIN, dns, usage: "cdn" }],
  cdn: [{ provider: "gcp", domain: DOMAIN, bucket: "site", path: "" }],
  ...overrides,
});

describe("planning a gcp CDN", () => {
  test("plans a global certificate and a CDN that depends on it and the bucket", () => {
    const actions = plan(config(), emptyState());
    expect(actions.map((a) => a.key)).toEqual(["@gcp.GCS.site", `@gcp.Certificate.${DOMAIN}`, `@gcp.CloudCdn.${DOMAIN}`]);
    expect(actions[1]!.desired!.spec).toMatchObject({ region: "global", for_endpoint: true });
    expect(actions[2]!.desired!.spec).toMatchObject({ domain: DOMAIN, bucket: "site", project: "my-proj-123" });
    expect(actions[2]!.desired!.deps).toEqual([`@gcp.Certificate.${DOMAIN}`, "@gcp.GCS.site"]);
  });

  test("the bucket MUST opt in to public read", () => {
    expect(() => plan(config({ project: "my-proj-123" }), emptyState())).toThrow(/makes bucket "site" public; set options public_read "true"/);
    expect(() => plan(config({}), emptyState())).toThrow(/public_read/);
  });

  test("a gcp CDN cannot serve an aws bucket or use an aws certificate", () => {
    const aws = config({ public_read: "true" }, { resource: [{ name: "site", type: "@aws.S3", physical_name: "site", dry: false, source: "setup.ts:1" }] });
    expect(() => plan(aws, emptyState())).toThrow(/serves bucket "site", which is a @aws.S3/);
    const cert = config({ public_read: "true" }, { certificate: [{ provider: "aws", domain: DOMAIN, dns, usage: "cdn" }] });
    expect(() => plan(cert, emptyState())).toThrow(/uses a aws certificate/);
  });

  test("a gcp certificate is global and cannot serve an API", () => {
    expect(() => plan(config({ public_read: "true" }, { certificate: [{ provider: "gcp", domain: DOMAIN, dns, usage: "cdn", region: "us-east-1" }] }), emptyState())).toThrow(/is global/);
  });

  test("CloudFront-only options are rejected", () => {
    const withOption = config({ public_read: "true" }, { cdn: [{ provider: "gcp", domain: DOMAIN, bucket: "site", path: "", options: { price_class: "PriceClass_100" } }] });
    expect(() => plan(withOption, emptyState())).toThrow(/unknown option "price_class" for @gcp.CloudCdn/);
  });

  test("apply refuses before changing anything until the driver exists", async () => {
    await expect(apply(plan(config(), emptyState()), emptyState(), {}, { save: () => {}, log: () => {} })).rejects.toThrow(/Nothing was changed. cloudgear cannot deploy/);
  });
});

describe("the CDN class", () => {
  const cert = () => new Cert("gcp", new DNS("gandi", DOMAIN, { zone: "example.com" }));
  const bucket = { provider: "gcp" } as never;

  test("serves a gcp bucket", () => {
    expect(new CDN("gcp", cert(), { bucket }).domain).toBe(DOMAIN);
  });

  test("rejects a router and the CloudFront-only options", () => {
    expect(() => new CDN("gcp", cert(), { router: { provider: "gcp" } })).toThrow(/bucket only/);
    expect(() => new CDN("gcp", cert(), { bucket, priceClass: "PriceClass_100" })).toThrow(/only apply to a CloudFront CDN/);
  });
});

describe("analyzing a gcp CDN", () => {
  const run = async (name: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-gcp-cdn-"));
    try {
      return await generate({ entry: path.join(import.meta.dir, "fixtures/router/edge", name), configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "gcpcdn" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a public bucket with a gcp certificate becomes a gcp CDN", async () => {
    const { config } = await run("gcp-site.ts");
    expect(config.cdn.map((c) => [c.provider, c.domain, c.bucket])).toEqual([["gcp", "www.example.org", "my-site"]]);
    expect(config.certificate.map((c) => [c.provider, c.usage])).toEqual([["gcp", "cdn"]]);
  });

  test("a bucket that is not public_read is an error", async () => {
    await expect(run("gcp-private.ts")).rejects.toThrow(/options: \{ public_read: "true" \}/);
  });

  test("the bucket must use the CDN's provider", async () => {
    await expect(run("gcp-aws-bucket.ts")).rejects.toThrow(/bucket must use provider "gcp"/);
  });
});
