import { describe, expect, test } from "bun:test";
import { adoptEntries } from "../src/deploy/adopt";
import { apply } from "../src/deploy/apply";
import { plan } from "../src/deploy/plan";
import type { CloudgearConfig } from "../src/config/schema";
import { MemoryDnsDriver } from "@cloudgear/dns/drivers/memory";
import { baseConfig, emptyState, fakeAws, fn } from "./helpers";

const notFound = (name = "ResourceNotFoundException") => Object.assign(new Error(name), { name });
const everything = () => true;

const lambdaConfig = () => baseConfig({ resource: [], function: [fn({ permission: [], env: [] })] });
const existingFunction = {
  GetFunctionCommand: () => ({ Configuration: { FunctionArn: "arn:aws:lambda:eu-west-1:1:function:app-foo", Role: "arn:aws:iam::1:role/my-own-role" } }),
  GetFunctionUrlConfigCommand: () => ({ FunctionUrl: "https://abc.lambda-url.eu-west-1.on.aws/" }),
};

describe("importing a function", () => {
  test("records its ARN, role and URL, and the next plan updates it instead of creating it", async () => {
    const aws = fakeAws(existingFunction);
    const state = emptyState();
    const config = lambdaConfig();
    const result = await adoptEntries(plan(config, state), state, aws.drivers, everything);
    expect(result.adopted).toEqual(["@aws.Lambda foo"]);
    expect(state.entries["@aws.Lambda.foo"]).toMatchObject({
      physical_name: "app-foo",
      spec: {},
      outputs: { arn: "arn:aws:lambda:eu-west-1:1:function:app-foo", role_arn: "arn:aws:iam::1:role/my-own-role", role_name: "my-own-role", url: "https://abc.lambda-url.eu-west-1.on.aws/" },
    });
    const actions = plan(config, state).filter((a) => a.type === "@aws.Lambda");
    expect(actions.map((a) => a.op)).toEqual(["update"]);
    expect(actions[0]!.changes).toContain("code");
  });

  test("apply then converges it with updates only, never a create", async () => {
    const aws = fakeAws(existingFunction);
    const state = emptyState();
    const config = lambdaConfig();
    await adoptEntries(plan(config, state), state, aws.drivers, everything);
    await apply(plan(config, state), state, aws.drivers, { save: () => {} });
    expect(aws.of("CreateFunctionCommand")).toEqual([]);
    expect(aws.of("CreateRoleCommand")).toEqual([]);
    expect(aws.of("UpdateFunctionCodeCommand")).toHaveLength(1);
    expect(aws.of("CreateFunctionUrlConfigCommand")).toEqual([]);
    expect(plan(config, state).every((a) => a.op === "noop" || a.op === "dry")).toBe(true);
  });

  test("a function that is not there is reported missing and left for apply to create", async () => {
    const aws = fakeAws({ GetFunctionCommand: () => { throw notFound(); } });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything);
    expect(result).toMatchObject({ adopted: [], missing: ["@aws.Lambda foo"] });
    expect(state.entries).toEqual({});
  });

  test("a function without a URL is imported without one", async () => {
    const aws = fakeAws({ ...existingFunction, GetFunctionUrlConfigCommand: () => { throw notFound(); } });
    const state = emptyState();
    await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything);
    expect(state.entries["@aws.Lambda.foo"]!.outputs.url).toBeUndefined();
  });

  test("destroy removes the function but leaves a role cloudgear did not make", async () => {
    const aws = fakeAws(existingFunction);
    const state = emptyState();
    const config = lambdaConfig();
    await adoptEntries(plan(config, state), state, aws.drivers, everything);
    const gone = fakeAws();
    await apply(plan(baseConfig({ resource: [], function: [] }), state), state, gone.drivers, { save: () => {} });
    expect(gone.of("DeleteFunctionCommand")).toHaveLength(1);
    expect(gone.of("DeleteRoleCommand")).toEqual([]);
  });

  test("destroy still removes the role of a function cloudgear created", async () => {
    const aws = fakeAws();
    const state = emptyState();
    await apply(plan(lambdaConfig(), state), state, aws.drivers, { save: () => {} });
    const gone = fakeAws();
    await apply(plan(baseConfig({ resource: [], function: [] }), state), state, gone.drivers, { save: () => {} });
    expect(gone.of("DeleteRoleCommand")).toHaveLength(1);
  });
});

describe("importing a certificate and a distribution", () => {
  const dnsSpec = { provider: "gandi", domain: "www.example.com", zone: "example.com" };
  const config = (): CloudgearConfig =>
    baseConfig({
      resource: [{ name: "web", type: "@aws.S3", physical_name: "my-web", dry: false, source: "a.ts:1" }],
      function: [],
      certificate: [{ provider: "aws", domain: "www.example.com", dns: dnsSpec, usage: "cdn" }],
      cdn: [{ provider: "aws", domain: "www.example.com", bucket: "web", path: "" }],
    });
  const existing = {
    HeadBucketCommand: () => ({}),
    ListCertificatesCommand: () => ({
      CertificateSummaryList: [
        { DomainName: "other.example.com", CertificateArn: "arn:acm:other", Status: "ISSUED" },
        { DomainName: "www.example.com", CertificateArn: "arn:aws:acm:us-east-1:1:certificate/pending", Status: "PENDING_VALIDATION" },
        { DomainName: "www.example.com", CertificateArn: "arn:aws:acm:us-east-1:1:certificate/issued", Status: "ISSUED" },
      ],
    }),
    ListDistributionsCommand: () => ({
      DistributionList: {
        IsTruncated: false,
        Items: [
          { Id: "EOTHER", ARN: "arn:other", DomainName: "dother.cloudfront.net", Status: "Deployed", Aliases: { Items: ["other.example.com"] } },
          { Id: "E42", ARN: "arn:aws:cloudfront::1:distribution/E42", DomainName: "d42.cloudfront.net", Status: "Deployed", Aliases: { Items: ["www.example.com"] } },
        ],
      },
    }),
  };

  test("finds the issued certificate by domain and the distribution by alias, and records the bucket as imported", async () => {
    const aws = fakeAws(existing);
    const state = emptyState();
    const result = await adoptEntries(plan(config(), state), state, aws.drivers, everything);
    expect(result.adopted.sort()).toEqual(["@aws.CloudFront www.example.com", "@aws.Certificate www.example.com", "@aws.S3 web"].sort());
    expect(state.entries["@aws.Certificate.www.example.com"]!.outputs).toEqual({ arn: "arn:aws:acm:us-east-1:1:certificate/issued" });
    expect(state.entries["@aws.CloudFront.www.example.com"]!.outputs).toMatchObject({ id: "E42", domain_name: "d42.cloudfront.net", url: "https://d42.cloudfront.net", status: "Deployed" });
    expect(state.entries["@aws.S3.web"]).toMatchObject({ imported: true, spec: { physical_name: "my-web" } });
  });

  test("apply then updates the distribution in place and creates nothing", async () => {
    const aws = fakeAws(existing, new MemoryDnsDriver());
    const state = emptyState();
    await adoptEntries(plan(config(), state), state, aws.drivers, everything);
    await apply(plan(config(), state), state, aws.drivers, { save: () => {} });
    expect(aws.of("CreateDistributionCommand")).toEqual([]);
    expect(aws.of("RequestCertificateCommand")).toEqual([]);
    expect(aws.of("UpdateDistributionCommand")).toHaveLength(1);
  });

  test("a bucket or distribution that does not exist is reported missing", async () => {
    const aws = fakeAws({ HeadBucketCommand: () => { throw notFound("NotFound"); }, ListCertificatesCommand: () => ({ CertificateSummaryList: [] }), ListDistributionsCommand: () => ({ DistributionList: { Items: [] } }) });
    const state = emptyState();
    const result = await adoptEntries(plan(config(), state), state, aws.drivers, everything);
    expect(result.adopted).toEqual([]);
    expect(result.missing.sort()).toEqual(["@aws.CloudFront www.example.com", "@aws.Certificate www.example.com", "@aws.S3 web"].sort());
  });

  test("a pending certificate is imported when none is issued, and entries already in state are skipped", async () => {
    const aws = fakeAws({ ...existing, ListCertificatesCommand: () => ({ CertificateSummaryList: [{ DomainName: "www.example.com", CertificateArn: "arn:aws:acm:us-east-1:1:certificate/pending", Status: "PENDING_VALIDATION" }] }) });
    const state = emptyState();
    await adoptEntries(plan(config(), state), state, aws.drivers, everything);
    expect(state.entries["@aws.Certificate.www.example.com"]!.outputs.arn).toMatch(/pending$/);
    const again = await adoptEntries(plan(config(), state), state, aws.drivers, everything);
    expect(again.adopted).toEqual([]);
    expect(again.skipped).toContain("@aws.Certificate www.example.com");
  });
});

describe("importing a schedule", () => {
  const config = () => baseConfig({ resource: [], function: [fn({ permission: [], env: [], schedule: ["0 3 * * *"] })] });

  test("records the rule by name", async () => {
    const aws = fakeAws({ ...existingFunction, DescribeRuleCommand: (input: { Name: string }) => ({ Arn: `arn:aws:events:eu-west-1:1:rule/${input.Name}` }) });
    const state = emptyState();
    const result = await adoptEntries(plan(config(), state), state, aws.drivers, everything);
    expect(result.adopted).toHaveLength(2);
    const key = Object.keys(state.entries).find((k) => k.startsWith("@aws.Schedule."))!;
    expect(state.entries[key]!.outputs).toMatchObject({ rule_name: state.entries[key]!.physical_name });
    await apply(plan(config(), state), state, aws.drivers, { save: () => {} });
    expect(aws.of("PutRuleCommand")).toHaveLength(1);
  });

  test("a rule that does not exist is reported missing", async () => {
    const aws = fakeAws({ ...existingFunction, DescribeRuleCommand: () => { throw notFound(); } });
    const state = emptyState();
    const result = await adoptEntries(plan(config(), state), state, aws.drivers, everything);
    expect(result.missing.some((m) => m.startsWith("@aws.Schedule"))).toBe(true);
  });
});

describe("choosing what to import", () => {
  test("a selector imports only what it matches", async () => {
    const aws = fakeAws(existingFunction);
    const state = emptyState();
    const config = baseConfig({ resource: [], function: [fn({ permission: [], env: [] }), fn({ name: "bar", physical_name: "app-bar", permission: [], env: [] })] });
    const result = await adoptEntries(plan(config, state), state, aws.drivers, (a) => a.name === "bar");
    expect(result.adopted).toEqual(["@aws.Lambda bar"]);
    expect(Object.keys(state.entries)).toEqual(["@aws.Lambda.bar"]);
  });
});
