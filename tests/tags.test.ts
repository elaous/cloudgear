import { describe, expect, test } from "bun:test";
import { baseTags, tagValue } from "../src/deploy/aws/tags";
import type { CloudgearConfig } from "../src/config/schema";
import { applyAll, baseConfig, emptyState, fakeAws, fn } from "./helpers";

const tags = baseTags({ project: "app", version: "0.1.0", env: "prod", author: "Ada Lovelace" });
const asMap = (list: { Key: string; Value: string }[]) => Object.fromEntries(list.map((t) => [t.Key, t.Value]));

describe("baseTags", () => {
  test("sets who, what and where", () => {
    expect(tags).toEqual({
      "cloudgear:managed-by": "cloudgear",
      "cloudgear:version": "0.1.0",
      "cloudgear:project": "app",
      "cloudgear:env": "prod",
      "cloudgear:author": "Ada Lovelace",
    });
  });

  test("omits env and author when unknown", () => {
    expect(Object.keys(baseTags({ project: "p", version: "1" }))).toEqual(["cloudgear:managed-by", "cloudgear:version", "cloudgear:project"]);
  });

  test("extra tags are kept but reserved prefixes are refused", () => {
    expect(baseTags({ project: "p", version: "1", extra: { team: "core" } }).team).toBe("core");
    expect(() => baseTags({ project: "p", version: "1", extra: { "cloudgear:env": "x" } })).toThrow(/reserved/);
    expect(() => baseTags({ project: "p", version: "1", extra: { "aws:x": "x" } })).toThrow(/reserved/);
  });

  test("invalid keys and too many tags are refused", () => {
    expect(() => baseTags({ project: "p", version: "1", extra: { "bad#key": "x" } })).toThrow(/invalid/);
    expect(() => baseTags({ project: "p", version: "1", extra: { ["k".repeat(129)]: "x" } })).toThrow(/invalid/);
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "v"]));
    expect(() => baseTags({ project: "p", version: "1", extra: many })).toThrow(/Too many tags/);
  });

  test("control characters and surrogate pairs are handled", () => {
    expect(tagValue("a\nb\tc")).toBe("a_b_c");
    expect(tagValue("𝒜".repeat(300))).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(Array.from(tagValue("𝒜".repeat(300)))).toHaveLength(256);
    expect(Array.from(tagValue("é".repeat(300)))).toHaveLength(256);
  });

  test("values drop characters AWS rejects and are capped at 256", () => {
    expect(tagValue("a<b>c")).toBe("a_b_c");
    expect(tagValue("x".repeat(300))).toHaveLength(256);
    expect(tagValue("ada@example.com")).toBe("ada@example.com");
  });
});

describe("applied tags", () => {
  test("bucket, role and function carry the tags and their logical name", async () => {
    const aws = await applyAll(baseConfig(), emptyState(), fakeAws({}, undefined, undefined, tags));
    expect(asMap(aws.of("PutBucketTaggingCommand")[0].Tagging.TagSet)).toMatchObject({ ...tags, "cloudgear:resource": "data" });
    expect(asMap(aws.of("CreateRoleCommand")[0].Tags)).toMatchObject({ ...tags, "cloudgear:resource": "foo" });
    expect(aws.of("CreateFunctionCommand")[0].Tags).toMatchObject({ ...tags, "cloudgear:resource": "foo" });
  });

  test("a failed bucket tag deletes the bucket", async () => {
    const aws = fakeAws({ PutBucketTaggingCommand: () => { throw new Error("AccessDenied"); } }, undefined, undefined, tags);
    await expect(applyAll(baseConfig(), emptyState(), aws)).rejects.toThrow(/AccessDenied/);
    expect(aws.of("DeleteBucketCommand")).toEqual([{ Bucket: "data" }]);
  });

  test("nothing is tagged when no tags are configured", async () => {
    const aws = await applyAll(baseConfig(), emptyState());
    expect(aws.of("PutBucketTaggingCommand")).toEqual([]);
    expect(aws.of("CreateRoleCommand")[0].Tags).toBeUndefined();
    expect(aws.of("CreateFunctionCommand")[0].Tags).toBeUndefined();
  });

  test("schedule rule, certificate, distribution and API are tagged", async () => {
    const dns = { provider: "gandi", domain: "cdn.example.com", zone: "example.com" };
    const config: CloudgearConfig = baseConfig({
      resource: [{ name: "site", type: "@aws.S3", physical_name: "site", dry: false, source: "a.ts:1" }],
      function: [fn({ permission: [], env: [], schedule: ["0 3 * * *"] })],
      certificate: [{ provider: "aws", domain: "cdn.example.com", dns, usage: "cdn" }],
      cdn: [{ provider: "aws", domain: "cdn.example.com", bucket: "site", path: "" }],
    });
    const aws = await applyAll(config, emptyState(), fakeAws({}, undefined, undefined, tags));
    expect(asMap(aws.of("PutRuleCommand")[0].Tags)).toMatchObject(tags);
    expect(asMap(aws.of("RequestCertificateCommand")[0].Tags)).toMatchObject({ ...tags, "cloudgear:resource": "cdn.example.com" });
    expect(asMap(aws.of("CreateDistributionWithTagsCommand")[0].DistributionConfigWithTags.Tags.Items)).toMatchObject(tags);
    expect(aws.of("CreateDistributionCommand")).toEqual([]);
  });

  test("the API and its domain are tagged", async () => {
    const dns = { provider: "gandi", domain: "api.example.com", zone: "example.com" };
    const config: CloudgearConfig = baseConfig({
      resource: [],
      function: [fn({ permission: [], env: [] })],
      certificate: [{ provider: "aws", domain: "api.example.com", dns, usage: "api" }],
      api: { provider: "aws", domain: "api.example.com" },
      region: "eu-west-1",
    });
    const aws = fakeAws({ RequestCertificateCommand: () => ({ CertificateArn: "arn:aws:acm:eu-west-1:1:certificate/api" }), CreateApiCommand: () => ({ ApiId: "api1", ApiEndpoint: "https://api1" }) }, undefined, undefined, tags);
    await applyAll(config, emptyState(), aws);
    expect(aws.of("CreateApiCommand")[0].Tags).toMatchObject({ ...tags, "cloudgear:resource": "api.example.com" });
    expect(aws.of("CreateDomainNameCommand")[0].Tags).toMatchObject(tags);
  });
});
