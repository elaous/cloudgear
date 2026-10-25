import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeApp } from "../src/analyze/app";
import { decodeConfig } from "../src/config/schema";
import { buildDistributionConfig } from "../src/deploy/aws/cloudfront";
import { plan, type CdnComparable } from "../src/deploy/plan";
import { generate } from "../src/generate";
import { applyAll, baseConfig, emptyState, fakeAws, fn } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "options", name);
const generated = async (file: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "options-"));
  const configPath = path.join(dir, "c.prototxt");
  const { config } = await generate({ entry: file, configPath, buildDir: path.join(dir, "b"), project: "app" });
  return { config, text: fs.readFileSync(configPath, "utf8") };
};

describe("provider options in source", () => {
  test("stores, functions, the certificate and the CDN carry their options", () => {
    const model = analyzeApp(fixture("ok.ts"));
    expect(model.resources[0]!.options).toEqual({ versioning: "true" });
    expect(Object.fromEntries(model.functions.map((f) => [f.name, f.options]))).toEqual({
      a: { tracing: "Active", "env.STAGE": "prod", ephemeral_storage_mb: "1024" },
      b: { tracing: "Active", "env.STAGE": "prod" },
    });
    const edge = analyzeApp(fixture("edge.ts"));
    expect(edge.certificate!.options).toEqual({ key_algorithm: "EC_prime256v1" });
    expect(edge.cdn!.options).toEqual({ price_class: "PriceClass_100", default_root_object: "home.html" });
  });

  test.each([
    ["variable-value.ts", /options\.versioning must be a string, number or boolean literal/],
    ["route-conflict.ts", /option "tracing" of "f" is "PassThrough" here but "Active" on another route/],
    ["store-conflict.ts", /BlobStore "data" is also declared at .* with a different provider, region or directives/],
  ])("rejects %s", (file, error) => {
    expect(() => analyzeApp(fixture(file))).toThrow(error);
  });
});

describe("options in the config", () => {
  test("round-trip through the prototxt as a proto map", async () => {
    const { config, text } = await generated(fixture("ok.ts"));
    expect(text).toContain('options {\n    key: "versioning"\n    value: "true"');
    expect(decodeConfig(text)).toEqual(config);
    expect(config.function.find((f) => f.name === "b")!.options).toEqual({ tracing: "Active", "env.STAGE": "prod" });
    const edge = await generated(fixture("edge.ts"));
    expect(decodeConfig(edge.text)).toEqual(edge.config);
    expect(edge.config.certificate!.options).toEqual({ key_algorithm: "EC_prime256v1" });
  });

  test("config without options has none", async () => {
    const { config, text } = await generated(path.join(import.meta.dir, "..", "examples", "router-app", "main.ts"));
    expect(text).not.toContain("options");
    expect(config.resource.every((r) => r.options === undefined)).toBe(true);
  });

  test.each([
    ["unknown-key.ts", /@aws\.S3 "data": unknown option "color" for @aws\.S3 \(supported: versioning\)/],
    ["bad-value.ts", /option "versioning" must be one of true, false/],
    ["reserved-env.ts", /option "env\.AWS_REGION" is not a usable environment variable name/],
  ])("generate rejects %s", async (file, error) => {
    await expect(generated(fixture(file))).rejects.toThrow(error);
  });

  test("plan validates a hand-edited config too", () => {
    const config = baseConfig({ function: [fn({ options: { tracing: "Sometimes" } })] });
    expect(() => plan(config, emptyState())).toThrow(/option "tracing" must be one of Active, PassThrough/);
  });
});

describe("planning options", () => {
  test("changing an option updates the entry, and state without options is untouched", async () => {
    const state = emptyState();
    await applyAll(baseConfig(), state);
    expect(plan(baseConfig(), state).every((a) => a.op === "noop" || a.op === "dry")).toBe(true);

    const withOptions = baseConfig({
      resource: [{ ...baseConfig().resource[0]!, options: { versioning: "true" } }, baseConfig().resource[1]!],
      function: [fn({ options: { tracing: "Active" } })],
    });
    const actions = plan(withOptions, state);
    expect(actions.find((a) => a.key === "@aws.S3.data")).toMatchObject({ op: "update", changes: ["spec"] });
    expect(actions.find((a) => a.key === "@aws.Lambda.foo")).toMatchObject({ op: "update", changes: ["config"] });
  });
});

describe("applying options on AWS", () => {
  test("a bucket is versioned on create and when the option changes", async () => {
    const versioned = (value?: string) =>
      baseConfig({
        resource: [{ ...baseConfig().resource[0]!, ...(value ? { options: { versioning: value } } : {}) }],
        function: [],
      });
    const state = emptyState();
    const aws = fakeAws();
    await applyAll(versioned("true"), state, aws);
    expect(aws.of("PutBucketVersioningCommand")).toEqual([{ Bucket: "data", VersioningConfiguration: { Status: "Enabled" } }]);

    await applyAll(versioned("false"), state, aws);
    expect(aws.of("PutBucketVersioningCommand").at(-1)).toEqual({ Bucket: "data", VersioningConfiguration: { Status: "Suspended" } });

    const plain = fakeAws();
    await applyAll(versioned(), emptyState(), plain);
    expect(plain.names()).not.toContain("PutBucketVersioningCommand");
  });

  test("a function gets tracing, storage and env options on create and update", async () => {
    const config = (options: Record<string, string>) => baseConfig({ resource: [], function: [fn({ options, permission: [], env: [] })] });
    const state = emptyState();
    const aws = fakeAws();
    await applyAll(config({ tracing: "Active", ephemeral_storage_mb: "1024", "env.STAGE": "prod" }), state, aws);
    expect(aws.of("CreateFunctionCommand")[0]).toMatchObject({
      TracingConfig: { Mode: "Active" },
      EphemeralStorage: { Size: 1024 },
      Environment: { Variables: expect.objectContaining({ STAGE: "prod", NODE_OPTIONS: "--enable-source-maps" }) },
    });
    await applyAll(config({ "env.STAGE": "dev" }), state, aws);
    expect(aws.of("UpdateFunctionConfigurationCommand")[0]).toMatchObject({
      TracingConfig: { Mode: "PassThrough" },
      EphemeralStorage: { Size: 512 },
      Environment: { Variables: expect.objectContaining({ STAGE: "dev" }) },
    });
  });

  test("the certificate and the distribution take their options", () => {
    const spec: CdnComparable = {
      domain: "cdn.example.com", dns_provider: "gandi", dns_zone: "example.com", bucket: "site", bucket_region: "", path: "", behaviors: [],
      options: { price_class: "PriceClass_100", default_root_object: "home.html" },
    };
    const input = { certificateArn: "arn", region: "us-east-1", oacS3: "oac", origins: new Map(), reference: "ref", enabled: true };
    expect(buildDistributionConfig(spec, input)).toMatchObject({ PriceClass: "PriceClass_100", DefaultRootObject: "home.html" });
    const plain = buildDistributionConfig({ ...spec, options: undefined }, input);
    expect(plain.DefaultRootObject).toBe("index.html");
    expect(plain.PriceClass).toBeUndefined();
  });

  test("a certificate is requested with its key algorithm and cannot change it later", async () => {
    const config = (key_algorithm?: string) =>
      baseConfig({
        resource: [],
        function: [],
        dns: { provider: "gandi", domain: "cdn.example.com", zone: "example.com" },
        certificate: { domain: "cdn.example.com", ...(key_algorithm ? { options: { key_algorithm } } : {}) },
      });
    const state = emptyState();
    const aws = fakeAws();
    await applyAll(config("EC_prime256v1"), state, aws);
    expect(aws.of("RequestCertificateCommand")[0]).toMatchObject({ KeyAlgorithm: "EC_prime256v1" });
    await expect(applyAll(config("RSA_2048"), state, aws)).rejects.toThrow(/cannot change key_algorithm/);
  });
});
