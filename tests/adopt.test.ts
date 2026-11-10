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

describe("what an import records and warns about", () => {
  const dnsSpec = { provider: "gandi", domain: "www.example.com", zone: "example.com" };
  const certConfig = (options?: Record<string, string>) =>
    baseConfig({ resource: [], function: [], certificate: [{ provider: "aws", domain: "www.example.com", dns: dnsSpec, usage: "cdn", ...(options ? { options } : {}) }] });

  test("the certificate search covers every key type, so an EC certificate is found", async () => {
    let asked: any;
    const aws = fakeAws({
      ListCertificatesCommand: (input: unknown) => {
        asked = input;
        return { CertificateSummaryList: [{ DomainName: "www.example.com", CertificateArn: "arn:ec", Status: "ISSUED", KeyAlgorithm: "EC_prime256v1", Type: "AMAZON_ISSUED" }] };
      },
    });
    const state = emptyState();
    await adoptEntries(plan(certConfig({ key_algorithm: "EC_prime256v1" }), state), state, aws.drivers, everything);
    expect(asked.Includes.keyTypes).toEqual(expect.arrayContaining(["RSA_2048", "EC_prime256v1", "EC_secp384r1"]));
    expect(state.entries["@aws.Certificate.www.example.com"]).toMatchObject({ outputs: { arn: "arn:ec" }, spec: { options: { key_algorithm: "EC_prime256v1" } } });
  });

  test("an adopted EC certificate converges without a key algorithm error", async () => {
    const aws = fakeAws({ ListCertificatesCommand: () => ({ CertificateSummaryList: [{ DomainName: "www.example.com", CertificateArn: "arn:aws:acm:us-east-1:1:certificate/ec", Status: "ISSUED", KeyAlgorithm: "EC_prime256v1", Type: "AMAZON_ISSUED" }] }) }, new MemoryDnsDriver());
    const state = emptyState();
    const config = certConfig({ key_algorithm: "EC_prime256v1" });
    await adoptEntries(plan(config, state), state, aws.drivers, everything);
    await apply(plan(config, state), state, aws.drivers, { save: () => {} });
    expect(aws.of("RequestCertificateCommand")).toEqual([]);
  });

  test("with several certificates for a domain, the issued one expiring last wins and a note says so", async () => {
    const aws = fakeAws({
      ListCertificatesCommand: () => ({
        CertificateSummaryList: [
          { DomainName: "www.example.com", CertificateArn: "arn:old", Status: "ISSUED", NotAfter: "2026-01-01T00:00:00Z" },
          { DomainName: "www.example.com", CertificateArn: "arn:new", Status: "ISSUED", NotAfter: "2027-01-01T00:00:00Z" },
        ],
      }),
    });
    const state = emptyState();
    const result = await adoptEntries(plan(certConfig(), state), state, aws.drivers, everything);
    expect(state.entries["@aws.Certificate.www.example.com"]!.outputs.arn).toBe("arn:new");
    expect(result.notes.join("\n")).toMatch(/2 certificates exist for www\.example\.com/);
  });

  test("an imported certificate is used as it is, with no DNS validation to wait for", async () => {
    const aws = fakeAws({ ListCertificatesCommand: () => ({ CertificateSummaryList: [{ DomainName: "www.example.com", CertificateArn: "arn:aws:acm:us-east-1:1:certificate/imp", Status: "ISSUED", Type: "IMPORTED" }] }) }, new MemoryDnsDriver());
    const state = emptyState();
    const result = await adoptEntries(plan(certConfig(), state), state, aws.drivers, everything);
    expect(result.notes.join("\n")).toMatch(/IMPORTED certificate/);
    await apply(plan(certConfig(), state), state, aws.drivers, { save: () => {} });
    expect(aws.of("DescribeCertificateCommand")).toEqual([]);
  });

  test("a function's reserved concurrency and URL auth are read, so the plan changes only what differs", async () => {
    const aws = fakeAws({
      ...existingFunction,
      GetFunctionCommand: () => ({ Configuration: { FunctionArn: "arn:aws:lambda:eu-west-1:1:function:app-foo", Role: "arn:aws:iam::1:role/r" }, Concurrency: { ReservedConcurrentExecutions: 5 } }),
      GetFunctionUrlConfigCommand: () => ({ FunctionUrl: "https://abc.lambda-url.eu-west-1.on.aws/", AuthType: "NONE" }),
    });
    const state = emptyState();
    await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything);
    expect(state.entries["@aws.Lambda.foo"]!.spec).toEqual({ reserved_concurrency: 5, auth: "none" });
    await apply(plan(lambdaConfig(), state), state, aws.drivers, { save: () => {} });
    expect(aws.of("DeleteFunctionConcurrencyCommand")).toHaveLength(1);
    expect(aws.of("UpdateFunctionUrlConfigCommand")).toHaveLength(1);
  });

  test("an update sets the handler, and a different handler or extra variables are warned about", async () => {
    const aws = fakeAws({
      GetFunctionCommand: () => ({ Configuration: { FunctionArn: "arn:aws:lambda:eu-west-1:1:function:app-foo", Role: "arn:aws:iam::1:role/r", Handler: "app.handler", Environment: { Variables: { LEGACY: "1", NODE_OPTIONS: "x" } } } }),
      GetFunctionUrlConfigCommand: () => { throw notFound(); },
    });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything);
    expect(result.notes.join("\n")).toMatch(/will be removed: LEGACY/);
    expect(result.notes.join("\n")).toMatch(/handler "app\.handler" will become index\.handler/);
    await apply(plan(lambdaConfig(), state), state, aws.drivers, { save: () => {} });
    expect(aws.of("UpdateFunctionConfigurationCommand")[0].Handler).toBe("index.handler");
  });

  test("a container image function is refused", async () => {
    const aws = fakeAws({ GetFunctionCommand: () => ({ Configuration: { FunctionArn: "arn", Role: "arn:aws:iam::1:role/r", PackageType: "Image" } }) });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything);
    expect(result.adopted).toEqual([]);
    expect(result.failed[0]).toMatch(/container image/);
  });

  test("two imported functions on one role each keep their own policy, and destroying one leaves the other's", async () => {
    const shared = { GetFunctionCommand: (input: { FunctionName: string }) => ({ Configuration: { FunctionArn: `arn:aws:lambda:eu-west-1:1:function:${input.FunctionName}`, Role: "arn:aws:iam::1:role/shared" } }), GetFunctionUrlConfigCommand: () => { throw notFound(); } };
    const config = baseConfig({
      resource: [{ name: "data", type: "@aws.S3", physical_name: "data", dry: false, source: "a.ts:1" }],
      function: [fn(), fn({ name: "bar", physical_name: "app-bar" })],
    });
    const aws = fakeAws(shared);
    const state = emptyState();
    await adoptEntries(plan(config, state), state, aws.drivers, (a) => a.type === "@aws.Lambda");
    await apply(plan(config, state), state, aws.drivers, { save: () => {} });
    const names = aws.of("PutRolePolicyCommand").map((p) => p.PolicyName).sort();
    expect(new Set(names).size).toBe(2);
    expect(names.every((n) => n.startsWith("cloudgear-app-"))).toBe(true);
    const gone = fakeAws();
    await apply(plan(baseConfig({ resource: config.resource, function: [fn()] }), state), state, gone.drivers, { save: () => {} });
    expect(gone.of("DeleteRolePolicyCommand")).toEqual([{ RoleName: "shared", PolicyName: names.find((n) => n.endsWith("bar"))! }]);
    expect(gone.of("DeleteRoleCommand")).toEqual([]);
  });

  test("an existing distribution's unmanaged settings are listed as warnings", async () => {
    const config = baseConfig({
      resource: [{ name: "web", type: "@aws.S3", physical_name: "my-web", dry: false, source: "a.ts:1" }],
      function: [],
      certificate: [{ provider: "aws", domain: "www.example.com", dns: dnsSpec, usage: "cdn" }],
      cdn: [{ provider: "aws", domain: "www.example.com", bucket: "web", path: "" }],
    });
    const aws = fakeAws({
      ListDistributionsCommand: () => ({ DistributionList: { Items: [{ Id: "E1", ARN: "arn", DomainName: "d1.cloudfront.net", Status: "Deployed", Aliases: { Items: ["www.example.com"] } }] } }),
      GetDistributionConfigCommand: () => ({ ETag: "e", DistributionConfig: { WebACLId: "arn:waf", Logging: { Enabled: true }, CustomErrorResponses: { Quantity: 2 }, Restrictions: { GeoRestriction: { RestrictionType: "whitelist" } }, CacheBehaviors: { Quantity: 3 }, Origins: { Quantity: 2 }, PriceClass: "PriceClass_100" } }),
    });
    const state = emptyState();
    const result = await adoptEntries(plan(config, state), state, aws.drivers, (a) => a.type === "@aws.CloudFront");
    const notes = result.notes.join("\n");
    for (const part of [/web ACL/, /access logging/, /2 custom error/, /geo restriction/, /3 path behavior/, /2 origin/, /price class/]) expect(notes).toMatch(part);
  });

  test("a bucket the credentials cannot read, or in another region, says so", async () => {
    const config = baseConfig({ function: [], resource: [{ name: "data", type: "@aws.S3", physical_name: "data", dry: false, source: "a.ts:1" }] });
    for (const [status, message] of [[403, /cannot read it/], [301, /is not in eu-west-1/]] as const) {
      const aws = fakeAws({ HeadBucketCommand: () => { throw Object.assign(new Error("x"), { name: "Other", $metadata: { httpStatusCode: status } }); } });
      const state = emptyState();
      const result = await adoptEntries(plan(config, state), state, aws.drivers, everything);
      expect(result.failed[0]).toMatch(message);
    }
  });

  test("one lookup failing does not stop the others from being recorded", async () => {
    const config = baseConfig({ function: [fn({ permission: [], env: [] })], resource: [{ name: "data", type: "@aws.S3", physical_name: "data", dry: false, source: "a.ts:1" }] });
    const aws = fakeAws({ ...existingFunction, HeadBucketCommand: () => { throw Object.assign(new Error("x"), { name: "Other", $metadata: { httpStatusCode: 403 } }); } });
    const state = emptyState();
    const result = await adoptEntries(plan(config, state), state, aws.drivers, everything);
    expect(result.adopted).toEqual(["@aws.Lambda foo"]);
    expect(result.failed).toHaveLength(1);
  });
});
