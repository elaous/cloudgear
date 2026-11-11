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

describe("importing a given ARN", () => {
  const dnsSpec = { provider: "gandi", domain: "www.example.com", zone: "example.com" };
  const certConfig = () => baseConfig({ resource: [], function: [], certificate: [{ provider: "aws", domain: "www.example.com", dns: dnsSpec, usage: "cdn" }] });
  const arn = "arn:aws:acm:us-east-1:111122223333:certificate/chosen";

  test("a certificate is taken by its ARN, even when others exist for the domain", async () => {
    let listed = false;
    const aws = fakeAws({
      ListCertificatesCommand: () => { listed = true; return { CertificateSummaryList: [] }; },
      DescribeCertificateCommand: () => ({ Certificate: { DomainName: "www.example.com", Status: "ISSUED", Type: "AMAZON_ISSUED", KeyAlgorithm: "RSA_2048" } }),
    });
    const state = emptyState();
    const result = await adoptEntries(plan(certConfig(), state), state, aws.drivers, everything, { arn });
    expect(result.adopted).toEqual(["@aws.Certificate www.example.com"]);
    expect(state.entries["@aws.Certificate.www.example.com"]!.outputs.arn).toBe(arn);
    expect(listed).toBe(false);
  });

  test("a certificate ARN for another domain, a wrong kind of ARN, and a missing certificate are errors or missing", async () => {
    const wrong = fakeAws({ DescribeCertificateCommand: () => ({ Certificate: { DomainName: "other.example.com", Status: "ISSUED" } }) });
    const state = emptyState();
    expect((await adoptEntries(plan(certConfig(), state), state, wrong.drivers, everything, { arn })).failed[0]).toMatch(/is a certificate for other\.example\.com, not www\.example\.com/);
    expect((await adoptEntries(plan(certConfig(), state), state, wrong.drivers, everything, { arn: "arn:aws:s3:::bucket" })).failed[0]).toMatch(/is not an ACM certificate ARN/);
    const none = fakeAws({ DescribeCertificateCommand: () => { throw notFound(); } });
    expect((await adoptEntries(plan(certConfig(), state), state, none.drivers, everything, { arn })).missing).toEqual(["@aws.Certificate www.example.com"]);
  });

  const cdnConfig = () =>
    baseConfig({
      resource: [{ name: "web", type: "@aws.S3", physical_name: "my-web", dry: false, source: "a.ts:1" }],
      function: [],
      certificate: [{ provider: "aws", domain: "www.example.com", dns: dnsSpec, usage: "cdn" }],
      cdn: [{ provider: "aws", domain: "www.example.com", bucket: "web", path: "" }],
    });
  const distributionArn = "arn:aws:cloudfront::111122223333:distribution/E42ABC";

  test("a distribution is taken by its ARN and must answer to the config's domain", async () => {
    const aws = fakeAws({ GetDistributionCommand: () => ({ Distribution: { Id: "E42ABC", ARN: distributionArn, DomainName: "d42.cloudfront.net", Status: "Deployed", DistributionConfig: { Aliases: { Items: ["www.example.com"] } } } }) });
    const state = emptyState();
    const result = await adoptEntries(plan(cdnConfig(), state), state, aws.drivers, (a) => a.type === "@aws.CloudFront", { arn: distributionArn });
    expect(result.adopted).toEqual(["@aws.CloudFront www.example.com"]);
    expect(state.entries["@aws.CloudFront.www.example.com"]!.outputs).toMatchObject({ id: "E42ABC", arn: distributionArn, domain_name: "d42.cloudfront.net" });
    const other = fakeAws({ GetDistributionCommand: () => ({ Distribution: { Id: "E42ABC", ARN: distributionArn, DomainName: "d42.cloudfront.net", Status: "Deployed", DistributionConfig: { Aliases: { Items: ["elsewhere.example.com"] } } } }) });
    const fresh = emptyState();
    expect((await adoptEntries(plan(cdnConfig(), fresh), fresh, other.drivers, (a) => a.type === "@aws.CloudFront", { arn: distributionArn })).failed[0]).toMatch(/does not answer to www\.example\.com \(its aliases: elsewhere\.example\.com\)/);
    expect((await adoptEntries(plan(cdnConfig(), fresh), fresh, other.drivers, (a) => a.type === "@aws.CloudFront", { arn: "arn:aws:acm:us-east-1:1:certificate/x" })).failed[0]).toMatch(/not a CloudFront distribution ARN/);
  });

  test("a function ARN must be the function the config deploys", async () => {
    const aws = fakeAws(existingFunction);
    const state = emptyState();
    const ok = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything, { arn: "arn:aws:lambda:eu-west-1:1:function:app-foo" });
    expect(ok.adopted).toEqual(["@aws.Lambda foo"]);
    const fresh = emptyState();
    expect((await adoptEntries(plan(lambdaConfig(), fresh), fresh, aws.drivers, everything, { arn: "arn:aws:lambda:eu-west-1:1:function:other" })).failed[0]).toMatch(/is the function "other", but the config deploys "app-foo"/);
    expect((await adoptEntries(plan(lambdaConfig(), fresh), fresh, aws.drivers, everything, { arn: "arn:aws:s3:::x" })).failed[0]).toMatch(/not a Lambda function ARN/);
  });

  test("a schedule rule ARN must be the rule the config deploys", async () => {
    const config = baseConfig({ resource: [], function: [fn({ permission: [], env: [], schedule: ["0 3 * * *"] })] });
    const aws = fakeAws({ ...existingFunction, DescribeRuleCommand: (input: { Name: string }) => ({ Arn: `arn:aws:events:eu-west-1:1:rule/${input.Name}` }) });
    const state = emptyState();
    const rule = plan(config, state).find((a) => a.type === "@aws.Schedule")!.desired!.physical_name;
    const ok = await adoptEntries(plan(config, state), state, aws.drivers, (a) => a.type === "@aws.Schedule", { arn: `arn:aws:events:eu-west-1:1:rule/${rule}` });
    expect(ok.adopted).toHaveLength(1);
    const fresh = emptyState();
    expect((await adoptEntries(plan(config, fresh), fresh, aws.drivers, (a) => a.type === "@aws.Schedule", { arn: "arn:aws:events:eu-west-1:1:rule/another" })).failed[0]).toMatch(/is the rule "another"/);
  });
});

describe("ARN checks that guard against the wrong thing", () => {
  const dnsSpec = { provider: "gandi", domain: "www.example.com", zone: "example.com" };
  const certConfig = () => baseConfig({ resource: [], function: [], certificate: [{ provider: "aws", domain: "www.example.com", dns: dnsSpec, usage: "cdn" }] });
  const describeCert = (status: string) => fakeAws({ DescribeCertificateCommand: () => ({ Certificate: { DomainName: "www.example.com", Status: status } }) });
  const failure = async (aws: ReturnType<typeof fakeAws>, config: CloudgearConfig, arn: string, select: (a: { type: string }) => boolean = everything) => {
    const state = emptyState();
    const result = await adoptEntries(plan(config, state), state, aws.drivers, select as never, { arn });
    return result.failed[0];
  };

  test("a certificate in another region than the config's is refused", async () => {
    expect(await failure(describeCert("ISSUED"), certConfig(), "arn:aws:acm:eu-west-1:111122223333:certificate/x")).toMatch(/is in eu-west-1, but this certificate must be in us-east-1/);
  });

  test.each(["FAILED", "EXPIRED", "REVOKED", "INACTIVE", "VALIDATION_TIMED_OUT"])("a %s certificate cannot be imported", async (status) => {
    expect(await failure(describeCert(status), certConfig(), "arn:aws:acm:us-east-1:111122223333:certificate/x")).toMatch(new RegExp(`is ${status}`));
  });

  test("a pending certificate can be", async () => {
    const aws = describeCert("PENDING_VALIDATION");
    const state = emptyState();
    const result = await adoptEntries(plan(certConfig(), state), state, aws.drivers, everything, { arn: "arn:aws:acm:us-east-1:111122223333:certificate/x" });
    expect(result.adopted).toHaveLength(1);
  });

  test("a China or GovCloud partition is read as an ARN, and is not mistaken for another service", async () => {
    const { parseArn } = await import("../src/deploy/aws/arn");
    expect(parseArn("arn:aws-cn:acm:cn-north-1:111122223333:certificate/x")).toMatchObject({ partition: "aws-cn", service: "acm", region: "cn-north-1", account: "111122223333" });
    expect(parseArn("arn:aws-us-gov:lambda:us-gov-west-1:111122223333:function:f")?.partition).toBe("aws-us-gov");
    expect(parseArn("not-an-arn")).toBeUndefined();
    expect(parseArn("arn:aws:cloudfront::111122223333:distribution/E1")).toMatchObject({ region: "", resource: "distribution/E1" });
    expect(await failure(describeCert("ISSUED"), certConfig(), "arn:aws-cn:s3:::bucket")).toMatch(/is not an ACM certificate ARN/);
  });

  test("a function ARN with a version or alias, in another region or in another account, is refused", async () => {
    const aws = fakeAws(existingFunction);
    expect(await failure(aws, lambdaConfig(), "arn:aws:lambda:eu-west-1:1:function:app-foo:3")).toMatch(/names a version or alias/);
    expect(await failure(aws, lambdaConfig(), "arn:aws:lambda:us-east-1:1:function:app-foo")).toMatch(/is in us-east-1, but the functions are deployed to eu-west-1/);
    expect(await failure(aws, lambdaConfig(), "arn:aws:lambda:eu-west-1:2:function:app-foo")).toMatch(/is in another account/);
  });

  test("a rule on a custom event bus, or in another region, is refused", async () => {
    const config = baseConfig({ resource: [], function: [fn({ permission: [], env: [], schedule: ["0 3 * * *"] })] });
    const aws = fakeAws({ ...existingFunction, DescribeRuleCommand: (input: { Name: string }) => ({ Arn: `arn:aws:events:eu-west-1:1:rule/${input.Name}` }) });
    const rule = plan(config, emptyState()).find((a) => a.type === "@aws.Schedule")!.desired!.physical_name;
    const onlySchedule = (a: { type: string }) => a.type === "@aws.Schedule";
    expect(await failure(aws, config, `arn:aws:events:eu-west-1:1:rule/custom-bus/${rule}`, onlySchedule)).toMatch(/custom event bus/);
    expect(await failure(aws, config, `arn:aws:events:us-east-1:1:rule/${rule}`, onlySchedule)).toMatch(/is not the rule that was found/);
  });

  test("a distribution ARN with a malformed account is refused, and a bucket ARN must name the config's bucket", async () => {
    const aws = fakeAws();
    const cdn = baseConfig({
      resource: [{ name: "web", type: "@aws.S3", physical_name: "my-web", dry: false, source: "a.ts:1" }],
      function: [],
      certificate: [{ provider: "aws", domain: "www.example.com", dns: dnsSpec, usage: "cdn" }],
      cdn: [{ provider: "aws", domain: "www.example.com", bucket: "web", path: "" }],
    });
    expect(await failure(aws, cdn, "arn:aws:cloudfront::acct:distribution/E1", (a) => a.type === "@aws.CloudFront")).toMatch(/is not a CloudFront distribution ARN/);
    expect(await failure(aws, cdn, "arn:aws:s3:::another-bucket", (a) => a.type === "@aws.S3")).toMatch(/is the bucket "another-bucket", but the config uses "my-web"/);
  });
});

describe("importing with only an ARN", () => {
  const dns = (domain: string) => ({ provider: "gandi", domain, zone: "example.com" });
  const twoCerts = () =>
    baseConfig({
      resource: [],
      function: [],
      certificate: ["www.example.com", "api.example.com"].map((domain) => ({ provider: "aws", domain, dns: dns(domain), usage: "cdn" as const })),
    });
  const arn = "arn:aws:acm:us-east-1:111122223333:certificate/api";

  test("the ARN's service tells the type, and the certificate it describes tells which entry", async () => {
    const { adoptByArn, typeOfArn } = await import("../src/deploy/adopt");
    expect(typeOfArn(arn)).toBe("@aws.Certificate");
    expect(typeOfArn("arn:aws:cloudfront::111122223333:distribution/E1")).toBe("@aws.CloudFront");
    expect(typeOfArn("arn:aws:lambda:eu-west-1:1:function:f")).toBe("@aws.Lambda");
    expect(typeOfArn("arn:aws:events:eu-west-1:1:rule/r")).toBe("@aws.Schedule");
    expect(typeOfArn("arn:aws:s3:::b")).toBe("@aws.S3");
    expect(() => typeOfArn("arn:aws:sqs:us-east-1:1:q")).toThrow(/sqs ARN is not supported/);
    expect(() => typeOfArn("nope")).toThrow(/is not an ARN/);
    const aws = fakeAws({ DescribeCertificateCommand: () => ({ Certificate: { DomainName: "api.example.com", Status: "ISSUED" } }) });
    const state = emptyState();
    const result = await adoptByArn(plan(twoCerts(), state), state, aws.drivers, "@aws.Certificate", arn);
    expect(result.adopted).toEqual(["@aws.Certificate api.example.com"]);
    expect(Object.keys(state.entries)).toEqual(["@aws.Certificate.api.example.com"]);
    expect(state.entries["@aws.Certificate.api.example.com"]!.outputs.arn).toBe(arn);
  });

  test("when no entry fits, each reason is listed and nothing is recorded", async () => {
    const { adoptByArn } = await import("../src/deploy/adopt");
    const aws = fakeAws({ DescribeCertificateCommand: () => ({ Certificate: { DomainName: "elsewhere.example.com", Status: "ISSUED" } }) });
    const state = emptyState();
    const result = await adoptByArn(plan(twoCerts(), state), state, aws.drivers, "@aws.Certificate", arn);
    expect(result.adopted).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed.join("\n")).toMatch(/is a certificate for elsewhere\.example\.com, not (www|api)\.example\.com/);
    expect(state.entries).toEqual({});
  });

  test("a function ARN finds the function of that name among several", async () => {
    const { adoptByArn } = await import("../src/deploy/adopt");
    const config = baseConfig({ resource: [], function: [fn({ permission: [], env: [] }), fn({ name: "bar", physical_name: "app-bar", permission: [], env: [] })] });
    const aws = fakeAws({ GetFunctionCommand: (input: { FunctionName: string }) => ({ Configuration: { FunctionArn: `arn:aws:lambda:eu-west-1:1:function:${input.FunctionName}`, Role: "arn:aws:iam::1:role/r" } }), GetFunctionUrlConfigCommand: () => { throw notFound(); } });
    const state = emptyState();
    const result = await adoptByArn(plan(config, state), state, aws.drivers, "@aws.Lambda", "arn:aws:lambda:eu-west-1:1:function:app-bar");
    expect(result.adopted).toEqual(["@aws.Lambda bar"]);
  });

  test("nothing is recorded when the ARN fits several entries, which are named", async () => {
    const { adoptByArn } = await import("../src/deploy/adopt");
    const config = baseConfig({
      resource: ["a", "b"].map((name) => ({ name, type: "@aws.S3", physical_name: `my-${name}`, dry: false, source: "a.ts:1" })),
      function: [],
      certificate: ["a.example.com", "b.example.com"].map((domain) => ({ provider: "aws", domain, dns: dns(domain), usage: "cdn" as const })),
      cdn: [
        { provider: "aws", domain: "a.example.com", bucket: "a", path: "" },
        { provider: "aws", domain: "b.example.com", bucket: "b", path: "" },
      ],
    });
    const distribution = { Distribution: { Id: "E1", ARN: "arn:aws:cloudfront::111122223333:distribution/E1", DomainName: "d1.cloudfront.net", Status: "Deployed", DistributionConfig: { Aliases: { Items: ["a.example.com", "b.example.com"] } } } };
    const aws = fakeAws({ GetDistributionCommand: () => distribution });
    const state = emptyState();
    const result = await adoptByArn(plan(config, state), state, aws.drivers, "@aws.CloudFront", "arn:aws:cloudfront::111122223333:distribution/E1");
    expect(result.adopted).toEqual([]);
    expect(result.failed[0]).toMatch(/fits several entries \(a\.example\.com, b\.example\.com\); say which/);
    expect(state.entries).toEqual({});
  });

  test("a failing candidate leaves state alone while the one that fits is recorded", async () => {
    const { adoptByArn } = await import("../src/deploy/adopt");
    const aws = fakeAws({ DescribeCertificateCommand: () => ({ Certificate: { DomainName: "api.example.com", Status: "ISSUED" } }) });
    const state = emptyState();
    const config = twoCerts();
    await adoptByArn(plan(config, state), state, aws.drivers, "@aws.Certificate", arn);
    expect(Object.keys(state.entries)).toEqual(["@aws.Certificate.api.example.com"]);
  });

  test("a function ARN is matched by name before any AWS call, and a name the config lacks says so", async () => {
    const { adoptByArn } = await import("../src/deploy/adopt");
    let calls = 0;
    const config = baseConfig({ resource: [], function: [fn({ permission: [], env: [] })] });
    const aws = fakeAws({ GetFunctionCommand: () => { calls++; return {}; } });
    const state = emptyState();
    const result = await adoptByArn(plan(config, state), state, aws.drivers, "@aws.Lambda", "arn:aws:lambda:eu-west-1:1:function:not-in-config");
    expect(calls).toBe(0);
    expect(result.failed).toEqual(['no @aws.Lambda entry is named "not-in-config" in the config']);
  });

  test("when every entry of the type is already imported, it says so instead of listing nothing", async () => {
    const { adoptByArn } = await import("../src/deploy/adopt");
    const aws = fakeAws({ DescribeCertificateCommand: () => ({ Certificate: { DomainName: "api.example.com", Status: "ISSUED" } }) });
    const state = emptyState();
    await adoptByArn(plan(twoCerts(), state), state, aws.drivers, "@aws.Certificate", arn);
    const config = baseConfig({ resource: [], function: [], certificate: [{ provider: "aws", domain: "api.example.com", dns: dns("api.example.com"), usage: "cdn" }] });
    const again = await adoptByArn(plan(config, state), state, aws.drivers, "@aws.Certificate", arn);
    expect(again.failed).toEqual(["all 1 @aws.Certificate entries in the config are already imported or are not managed here"]);
    expect((await adoptByArn(plan(baseConfig({ resource: [], function: [] }), emptyState()), emptyState(), aws.drivers, "@aws.CloudFront", "arn:aws:cloudfront::1:distribution/E1")).failed).toEqual(["the config has no @aws.CloudFront entry"]);
  });

  test("identical reasons are listed once with every entry they apply to", async () => {
    const { adoptByArn } = await import("../src/deploy/adopt");
    const aws = fakeAws({ DescribeCertificateCommand: () => ({ Certificate: { DomainName: "x", Status: "ISSUED" } }) });
    const config = baseConfig({ resource: [], function: [], certificate: ["a", "b", "c", "d", "e", "f", "g"].map((n) => ({ provider: "aws", domain: `${n}.example.com`, dns: dns(`${n}.example.com`), usage: "cdn" as const })) });
    const state = emptyState();
    const result = await adoptByArn(plan(config, state), state, aws.drivers, "@aws.Certificate", arn);
    expect(result.failed.length).toBe(6);
    expect(result.failed.at(-1)).toBe("... and 2 more");
  });
});
