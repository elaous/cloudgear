import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeApp } from "../src/analyze/app";
import { decodeConfig } from "../src/config/schema";
import { encodeConfig } from "../src/config/schema";
import { policyDocument } from "../src/deploy/aws";
import { validateOptions } from "../src/providers";
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
      a: { tracing: "PassThrough", "env.STAGE": "prod", ephemeral_storage_mb: "1024" },
      b: { tracing: "Active", "env.STAGE": "prod" },
    });
    const edge = analyzeApp(fixture("edge.ts"));
    expect(edge.certificates[0]!.options).toEqual({ key_algorithm: "EC_prime256v1" });
    expect(edge.cdns[0]!.options).toEqual({ price_class: "PriceClass_100", default_root_object: "home.html", web_acl: "true" });
    expect(analyzeApp(fixture("price-class.ts")).cdns[0]!.options).toEqual({ price_class: "PriceClass_200" });
    expect(analyzeApp(fixture("router-web-acl.ts")).api?.options).toEqual({ web_acl: "arn:aws:wafv2:us-east-1:111122223333:global/webacl/mine/b576f740-7bb3-4e5f-849b-af9d3c2b0c27" });
  });

  test.each([
    ["variable-value.ts", /options\.versioning must be a string, number or boolean literal/],
    ["route-conflict.ts", /the routes of "f" give it different options/],
    ["route-partial.ts", /the routes of "f" give it different options/],
    ["proto-key.ts", /key "__proto__" must start with a letter/],
    ["price-class-both.ts", /give priceClass or options\.price_class, not both/],
    ["web-acl-both.ts", /give webAcl or options\.web_acl, not both/],
    ["web-acl-variable.ts", /webAcl must be true or a string literal, got: acl/],
    ["store-conflict.ts", /BlobStore "data" is also declared at .* with a different provider, region, options or directives/],
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
    expect(edge.config.certificate[0]!.options).toEqual({ key_algorithm: "EC_prime256v1" });
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

describe("option validation", () => {
  const check = (type: string, options: Record<string, string>) => () => validateOptions("aws", type, options, "x");

  test("names that exist on every object are unknown options", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(check("@aws.S3", { [key]: "1" })).toThrow(/unknown option/);
    }
  });

  test("environment variable names", () => {
    for (const name of ["AWS_REGION", "CLOUDGEAR_BLOB_X", "NODE_OPTIONS", "LAMBDA_TASK_ROOT", "_HANDLER", "", "1X", "a-b"]) {
      expect(check("@aws.Lambda", { [`env.${name}`]: "v" })).toThrow(/not a usable environment variable name/);
    }
    expect(check("@aws.Lambda", { "env.STAGE": "", "env.Mixed_case1": "v" })).not.toThrow();
  });

  test("value rules and their bounds", () => {
    for (const value of ["511", "10241", "abc", "1e3", "-1", ""]) {
      expect(check("@aws.Lambda", { ephemeral_storage_mb: value })).toThrow(/integer from 512 to 10240/);
    }
    for (const value of ["512", "10240"]) expect(check("@aws.Lambda", { ephemeral_storage_mb: value })).not.toThrow();
    expect(check("@aws.CloudFront", { price_class: "PriceClass_50" })).toThrow(/must be one of/);
    for (const value of ["/index.html", "a/../b"]) expect(check("@aws.CloudFront", { default_root_object: value })).toThrow(/relative object key/);
    expect(check("@aws.CloudFront", { default_root_object: "docs/home.html" })).not.toThrow();
    const acl = "arn:aws:wafv2:us-east-1:920042984913:global/webacl/CreatedByCloudFront-eab45982/b576f740-7bb3-4e5f-849b-af9d3c2b0c27";
    expect(check("@aws.CloudFront", { web_acl: acl })).not.toThrow();
    expect(check("@aws.CloudFront", { web_acl: "true" })).not.toThrow();
    expect(check("@aws.CloudFront", { free_plan: "true" })).not.toThrow();
    expect(check("@aws.CloudFront", { free_plan: "yes" })).toThrow(/must be one of true, false/);
    for (const value of ["", "arn:aws:wafv2:eu-west-1:920042984913:regional/webacl/x/b576f740-7bb3-4e5f-849b-af9d3c2b0c27", "arn:aws:s3:::bucket", "web-acl", "arn:aws-cn:wafv2:us-east-1:920042984913:global/webacl/x/b576f740-7bb3-4e5f-849b-af9d3c2b0c27", "arn:aws:wafv2:us-east-1:920042984913:global/webacl/x/------------------------------------", " arn:aws:wafv2:us-east-1:920042984913:global/webacl/x/b576f740-7bb3-4e5f-849b-af9d3c2b0c27", "b576f740-7bb3-4e5f-849b-af9d3c2b0c27"]) {
      expect(check("@aws.CloudFront", { web_acl: value })).toThrow(/WAFv2 web ACL ARN in us-east-1/);
    }
    expect(check("@aws.Certificate", { key_algorithm: "DSA" })).toThrow(/must be one of/);
  });

  test("the config round-trips awkward values", () => {
    const base = baseConfig({ function: [fn({ options: { "env.A": 'say "hi"\n', "env.B": "line1\nline2", "env.C": "", "env.D": "back\\slash" } })] });
    const decoded = decodeConfig(encodeConfig(base));
    expect(decoded.function[0]!.options).toEqual(base.function[0]!.options);
    expect(decoded.resource.every((r) => r.options === undefined)).toBe(true);
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
    await applyAll(versioned("true"), state, aws);
    await applyAll(versioned(), state, aws);
    expect(aws.of("PutBucketVersioningCommand")).toHaveLength(4);
    expect(aws.of("PutBucketVersioningCommand").at(-1)).toMatchObject({ VersioningConfiguration: { Status: "Suspended" } });

    const plain = fakeAws();
    await applyAll(versioned(), emptyState(), plain);
    expect(plain.names()).not.toContain("PutBucketVersioningCommand");
  });

  test("options override the function's own env, and the unset ones fall back to defaults", async () => {
    const aws = fakeAws();
    await applyAll(baseConfig({ resource: [], function: [fn({ permission: [], env: [{ key: "FOO", value: "a" }], options: { "env.FOO": "b" } })] }), emptyState(), aws);
    expect(aws.of("CreateFunctionCommand")[0].Environment.Variables).toEqual({ NODE_OPTIONS: "--enable-source-maps", FOO: "b" });
    expect(aws.of("CreateFunctionCommand")[0]).toMatchObject({ TracingConfig: { Mode: "PassThrough" }, EphemeralStorage: { Size: 512 } });
  });

  test("active tracing lets the role write X-Ray segments, and turning it on later adds that", async () => {
    const withTracing = (tracing?: string) => baseConfig({ resource: [], function: [fn({ permission: [], env: [], ...(tracing ? { options: { tracing } } : {}) })] });
    const state = emptyState();
    const aws = fakeAws();
    await applyAll(withTracing(), state, aws);
    expect(aws.names()).not.toContain("PutRolePolicyCommand");
    await applyAll(withTracing("Active"), state, aws);
    const statements = JSON.parse(aws.of("PutRolePolicyCommand")[0].PolicyDocument).Statement;
    expect(statements).toEqual([{ Effect: "Allow", Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource: "*" }]);
    await applyAll(withTracing(), state, aws);
    expect(aws.names()).toContain("DeleteRolePolicyCommand");
    expect(JSON.parse(policyDocument({ permissions: [] } as never)).Statement).toEqual([]);
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

  test("the distribution takes its options", () => {
    const spec: CdnComparable = {
      domain: "cdn.example.com", dns_provider: "gandi", dns_zone: "example.com", bucket: "site", bucket_region: "", path: "",
      options: { price_class: "PriceClass_100", default_root_object: "home.html" },
    };
    const input = { certificateArn: "arn", region: "us-east-1", oacS3: "oac", reference: "ref", enabled: true };
    expect(buildDistributionConfig(spec, input)).toMatchObject({ PriceClass: "PriceClass_100", DefaultRootObject: "home.html" });
    const plain = buildDistributionConfig({ ...spec, options: undefined }, input);
    expect(plain.DefaultRootObject).toBe("index.html");
    expect(plain.PriceClass).toBe("PriceClass_All");
  });

  test("a certificate is requested with its key algorithm and cannot change it later", async () => {
    const config = (key_algorithm?: string) =>
      baseConfig({
        resource: [],
        function: [],
        certificate: [
          {
            provider: "aws",
            domain: "cdn.example.com",
            dns: { provider: "gandi", domain: "cdn.example.com", zone: "example.com" },
            ...(key_algorithm ? { options: { key_algorithm } } : {}),
          },
        ],
      });
    const state = emptyState();
    const aws = fakeAws();
    await applyAll(config("EC_prime256v1"), state, aws);
    expect(aws.of("RequestCertificateCommand")[0]).toMatchObject({ KeyAlgorithm: "EC_prime256v1" });
    await expect(applyAll(config("RSA_2048"), state, aws)).rejects.toThrow(/cannot change key_algorithm/);

    const defaulted = emptyState();
    await applyAll(config(), defaulted, fakeAws());
    await expect(applyAll(config("RSA_2048"), defaulted, fakeAws())).resolves.toBeDefined();
  });
});
