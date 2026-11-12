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

  test("a default root object that differs from the config's is warned about, and the warning goes away once it matches", async () => {
    const aws = fakeAws({
      ListDistributionsCommand: () => ({ DistributionList: { Items: [{ Id: "E1", ARN: "arn", DomainName: "d1.cloudfront.net", Status: "Deployed", Aliases: { Items: ["www.example.com"] } }] } }),
      GetDistributionConfigCommand: () => ({ ETag: "e", DistributionConfig: { DefaultRootObject: "" } }),
    });
    const cdnConfig = (options?: Record<string, string>) =>
      baseConfig({
        resource: [{ name: "web", type: "@aws.S3", physical_name: "my-web", dry: false, source: "a.ts:1" }],
        function: [],
        certificate: [{ provider: "aws", domain: "www.example.com", dns: dnsSpec, usage: "cdn" }],
        cdn: [{ provider: "aws", domain: "www.example.com", bucket: "web", path: "", ...(options ? { options } : {}) }],
      });
    const only = (a: { type: string }) => a.type === "@aws.CloudFront";
    const first = emptyState();
    const warned = await adoptEntries(plan(cdnConfig(), first), first, aws.drivers, only as never);
    expect(warned.notes.join("\n")).toContain('its default root object is empty; apply will set "index.html" unless the config sets options: { default_root_object: "" }');
    const second = emptyState();
    const quiet = await adoptEntries(plan(cdnConfig({ default_root_object: "" }), second), second, aws.drivers, only as never);
    expect(quiet.notes.join("\n")).not.toMatch(/default root object/);
  });

  test("the web ACL warning names the option that keeps it, and goes away once the CDN keeps it", async () => {
    const acl = "arn:aws:wafv2:us-east-1:111122223333:global/webacl/mine/b576f740-7bb3-4e5f-849b-af9d3c2b0c27";
    const aws = fakeAws({
      ListDistributionsCommand: () => ({ DistributionList: { Items: [{ Id: "E1", ARN: "arn", DomainName: "d1.cloudfront.net", Status: "Deployed", Aliases: { Items: ["www.example.com"] } }] } }),
      GetDistributionConfigCommand: () => ({ ETag: "e", DistributionConfig: { WebACLId: acl } }),
    });
    const cdnConfig = (options?: Record<string, string>) =>
      baseConfig({
        resource: [{ name: "web", type: "@aws.S3", physical_name: "my-web", dry: false, source: "a.ts:1" }],
        function: [],
        certificate: [{ provider: "aws", domain: "www.example.com", dns: dnsSpec, usage: "cdn" }],
        cdn: [{ provider: "aws", domain: "www.example.com", bucket: "web", path: "", ...(options ? { options } : {}) }],
      });
    const only = (a: { type: string }) => a.type === "@aws.CloudFront";
    const classic = fakeAws({
      ListDistributionsCommand: () => ({ DistributionList: { Items: [{ Id: "E1", ARN: "arn", DomainName: "d1.cloudfront.net", Status: "Deployed", Aliases: { Items: ["www.example.com"] } }] } }),
      GetDistributionConfigCommand: () => ({ ETag: "e", DistributionConfig: { WebACLId: "a1b2c3d4-0000-1111-2222-333344445555" } }),
    });
    const fresh = emptyState();
    const classicResult = await adoptEntries(plan(cdnConfig(), fresh), fresh, classic.drivers, only as never);
    expect(classicResult.notes.join("\n")).toContain("webAcl: true");
    const without = emptyState();
    const warned = await adoptEntries(plan(cdnConfig(), without), without, aws.drivers, only as never);
    expect(warned.notes.join("\n")).toContain("webAcl: true");
    const kept = emptyState();
    const quiet = await adoptEntries(plan(cdnConfig({ web_acl: acl }), kept), kept, aws.drivers, only as never);
    expect(quiet.notes.join("\n")).not.toMatch(/web ACL/);
    const keeping = emptyState();
    const keptNote = await adoptEntries(plan(cdnConfig({ web_acl: "true" }), keeping), keeping, aws.drivers, only as never);
    expect(keptNote.notes.join("\n")).toContain(`its web ACL (${acl}) is kept`);
    expect(keptNote.notes.join("\n")).not.toMatch(/detached/);
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

describe("exporting the policies of an imported function's role", () => {
  const encoded = (document: unknown) => encodeURIComponent(JSON.stringify(document));
  const readBucket = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::data/*" }] };
  const managed = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: "*" }] };
  const iam = {
    ListRolePoliciesCommand: () => ({ PolicyNames: ["read-bucket", "cloudgear", "cloudgear-app-foo", "../evil"], IsTruncated: false }),
    GetRolePolicyCommand: (input: { PolicyName: string }) => ({ PolicyDocument: encoded(input.PolicyName === "read-bucket" ? readBucket : { Version: "2012-10-17", Statement: [] }) }),
    ListAttachedRolePoliciesCommand: () => ({
      AttachedPolicies: [
        { PolicyName: "AWSLambdaBasicExecutionRole", PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" },
        { PolicyName: "queue-writer", PolicyArn: "arn:aws:iam::111122223333:policy/queue-writer" },
      ],
    }),
    GetPolicyCommand: () => ({ Policy: { DefaultVersionId: "v3" } }),
    GetPolicyVersionCommand: () => ({ PolicyVersion: { Document: encoded(managed) } }),
  };

  test("writes the inline and customer-managed policies as JSON and an index, and skips the ones cloudgear owns", async () => {
    const aws = fakeAws({ ...existingFunction, ...iam });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything, { exportPolicies: true });
    const files = Object.fromEntries(result.files.map((f) => [f.path, f.content]));
    expect(Object.keys(files).sort()).toEqual(["my-own-role/index.json", "my-own-role/inline-.._evil.json", "my-own-role/inline-cloudgear.json", "my-own-role/inline-read-bucket.json", "my-own-role/managed-queue-writer.json"]);
    expect(JSON.parse(files["my-own-role/inline-read-bucket.json"]!)).toEqual(readBucket);
    expect(JSON.parse(files["my-own-role/managed-queue-writer.json"]!)).toEqual(managed);
    expect(JSON.parse(files["my-own-role/index.json"]!)).toEqual({
      role: "my-own-role",
      inline: ["read-bucket", "cloudgear", "../evil"],
      customerManaged: [{ name: "queue-writer", arn: "arn:aws:iam::111122223333:policy/queue-writer" }],
      awsManaged: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
    });
    expect(result.notes.join("\n")).toMatch(/policies of role my-own-role were exported \(3 inline, 1 customer-managed, 1 AWS-managed\); cloudgear does not manage them/);
  });

  test("a policy name cannot escape the directory, and the files end with a newline", async () => {
    const aws = fakeAws({ ...existingFunction, ...iam });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything, { exportPolicies: true });
    for (const file of result.files) {
      expect(file.path.split("/")).toHaveLength(2);
      expect(file.path).not.toMatch(/\.\.\//);
      expect(file.content.endsWith("\n")).toBe(true);
    }
  });

  test("nothing is read from IAM unless asked, and the policies are not recorded as managed", async () => {
    const aws = fakeAws({ ...existingFunction, ...iam });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything);
    expect(result.files).toEqual([]);
    expect(aws.of("ListRolePoliciesCommand")).toEqual([]);
  });

  test("a function with no policies of its own exports just the index", async () => {
    const aws = fakeAws({ ...existingFunction, ListRolePoliciesCommand: () => ({ PolicyNames: [] }), ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }) });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything, { exportPolicies: true });
    expect(result.files.map((f) => f.path)).toEqual(["my-own-role/index.json"]);
  });

  test("paginated policy lists are read in full", async () => {
    const pages = [{ PolicyNames: ["a"], IsTruncated: true, Marker: "m1" }, { PolicyNames: ["b"], IsTruncated: false }];
    let call = 0;
    const aws = fakeAws({ ...existingFunction, ...iam, ListRolePoliciesCommand: () => pages[call++], ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }) });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything, { exportPolicies: true });
    expect(result.files.map((f) => f.path).sort()).toEqual(["my-own-role/index.json", "my-own-role/inline-a.json", "my-own-role/inline-b.json"]);
  });

  test("an IAM error while exporting does not stop the function from being imported", async () => {
    const aws = fakeAws({ ...existingFunction, ListRolePoliciesCommand: () => { throw Object.assign(new Error("not authorized to perform iam:ListRolePolicies"), { name: "AccessDenied" }); } });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything, { exportPolicies: true });
    expect(result.adopted).toEqual(["@aws.Lambda foo"]);
    expect(result.files).toEqual([]);
    expect(result.notes.join("\n")).toMatch(/could not be exported \(not authorized to perform iam:ListRolePolicies\); the function is imported anyway/);
  });

  test("a policy removed while it is read is listed in the index, not fatal", async () => {
    const aws = fakeAws({
      ...existingFunction,
      ...iam,
      ListRolePoliciesCommand: () => ({ PolicyNames: ["gone", "kept"] }),
      GetRolePolicyCommand: (input: { PolicyName: string }) => {
        if (input.PolicyName === "gone") throw Object.assign(new Error("gone"), { name: "NoSuchEntity" });
        return { PolicyDocument: encoded(readBucket) };
      },
      ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }),
    });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything, { exportPolicies: true });
    const index = JSON.parse(result.files.find((f) => f.path.endsWith("index.json"))!.content);
    expect(index).toMatchObject({ inline: ["kept"], removedWhileReading: ["gone"] });
  });

  test("two attached policies with one name in different paths get different files", async () => {
    const aws = fakeAws({
      ...existingFunction,
      ...iam,
      ListRolePoliciesCommand: () => ({ PolicyNames: [] }),
      ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [{ PolicyName: "writer", PolicyArn: "arn:aws:iam::1:policy/a/writer" }, { PolicyName: "writer", PolicyArn: "arn:aws:iam::1:policy/b/writer" }] }),
    });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything, { exportPolicies: true });
    expect(result.files.map((f) => f.path).sort()).toEqual(["my-own-role/index.json", "my-own-role/managed-writer-2.json", "my-own-role/managed-writer.json"]);
  });

  test("a role named .. does not become a directory outside the target", async () => {
    const aws = fakeAws({ ...existingFunction, ...iam, GetFunctionCommand: () => ({ Configuration: { FunctionArn: "arn:aws:lambda:eu-west-1:1:function:app-foo", Role: "arn:aws:iam::1:role/.." } }), ListRolePoliciesCommand: () => ({ PolicyNames: ["read-bucket"] }), ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }) });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything, { exportPolicies: true });
    for (const file of result.files) expect(file.path).toMatch(/^role-2-dots\/[^/]+\.json$/);
  });

  test("a policy named like cloudgear's is skipped only on the role cloudgear made", async () => {
    const foreign = fakeAws({ ...existingFunction, ...iam, ListRolePoliciesCommand: () => ({ PolicyNames: ["cloudgear", "cloudgear-app-foo"] }), ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }) });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, foreign.drivers, everything, { exportPolicies: true });
    expect(result.files.map((f) => f.path).sort()).toEqual(["my-own-role/index.json", "my-own-role/inline-cloudgear.json"]);
    const own = fakeAws({ ...existingFunction, ...iam, GetFunctionCommand: () => ({ Configuration: { FunctionArn: "arn:aws:lambda:eu-west-1:1:function:app-foo", Role: "arn:aws:iam::1:role/app-foo-role" } }), ListRolePoliciesCommand: () => ({ PolicyNames: ["cloudgear", "audit"] }), ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }) });
    const fresh = emptyState();
    const again = await adoptEntries(plan(lambdaConfig(), fresh), fresh, own.drivers, everything, { exportPolicies: true });
    expect(again.files.map((f) => f.path).sort()).toEqual(["app-foo-role/index.json", "app-foo-role/inline-audit.json"]);
  });

  test("a function without a role says why nothing was exported", async () => {
    const aws = fakeAws({ ...existingFunction, GetFunctionCommand: () => ({ Configuration: { FunctionArn: "arn:aws:lambda:eu-west-1:1:function:app-foo" } }) });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything, { exportPolicies: true });
    expect(result.notes.join("\n")).toMatch(/has no role, so there are no policies to export/);
  });

  test("an already imported function is exported again without changing state", async () => {
    const aws = fakeAws({ ...existingFunction, ...iam });
    const state = emptyState();
    await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything);
    const before = JSON.stringify(state);
    const again = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything, { exportPolicies: true });
    expect(again.adopted).toEqual([]);
    expect(again.files.length).toBeGreaterThan(0);
    expect(JSON.stringify(state)).toBe(before);
  });

  test("a document that is already plain JSON is read as it is", async () => {
    const aws = fakeAws({ ...existingFunction, ...iam, GetRolePolicyCommand: () => ({ PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:*", Resource: "arn:aws:s3:::100%-bucket/*" }] }) }), ListRolePoliciesCommand: () => ({ PolicyNames: ["plain"] }), ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }) });
    const state = emptyState();
    const result = await adoptEntries(plan(lambdaConfig(), state), state, aws.drivers, everything, { exportPolicies: true });
    expect(JSON.parse(result.files.find((f) => f.path.endsWith("inline-plain.json"))!.content).Statement[0].Resource).toBe("arn:aws:s3:::100%-bucket/*");
  });

  test("by ARN, only the entry that fits returns files", async () => {
    const { adoptByArn } = await import("../src/deploy/adopt");
    const config = baseConfig({ resource: [], function: [fn({ permission: [], env: [] }), fn({ name: "bar", physical_name: "app-bar", permission: [], env: [] })] });
    const aws = fakeAws({ ...existingFunction, ...iam, GetFunctionCommand: (input: { FunctionName: string }) => ({ Configuration: { FunctionArn: `arn:aws:lambda:eu-west-1:1:function:${input.FunctionName}`, Role: `arn:aws:iam::1:role/${input.FunctionName}-r` } }) });
    const state = emptyState();
    const result = await adoptByArn(plan(config, state), state, aws.drivers, "@aws.Lambda", "arn:aws:lambda:eu-west-1:1:function:app-bar", true);
    expect(result.adopted).toEqual(["@aws.Lambda bar"]);
    expect(result.files.every((f) => f.path.startsWith("app-bar-r/"))).toBe(true);
  });
});

describe("writing the exported files", () => {
  test("they are checked together, written once each, and say what changed", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { planPolicyFiles, writePolicyFiles } = await import("../src/policyfiles");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-files-"));
    try {
      expect(() => planPolicyFiles(dir, [{ path: "ok/a.json", content: "{}\n" }, { path: "../escape.json", content: "{}\n" }])).toThrow(/Refusing to write "\.\.\/escape\.json" outside/);
      expect(() => planPolicyFiles(dir, [{ path: "r/a.json", content: "1" }, { path: "r/a.json", content: "2" }])).toThrow(/Two different policies/);
      const lines: string[] = [];
      const files = [{ path: "role/a.json", content: "{}\n" }, { path: "role/a.json", content: "{}\n" }, { path: "role/index.json", content: "[]\n" }];
      writePolicyFiles(dir, files, (l) => lines.push(l));
      expect(lines.map((l) => l.replace(/ \S*policy-files-[^/]*\//, " "))).toEqual(["cloudgear: wrote role/a.json", "cloudgear: wrote role/index.json"]);
      lines.length = 0;
      fs.writeFileSync(path.join(dir, "role", "index.json"), "old\n");
      writePolicyFiles(dir, files, (l) => lines.push(l));
      expect(lines.map((l) => l.replace(/ \S*policy-files-[^/]*\//, " "))).toEqual(["cloudgear: role/a.json is unchanged", "cloudgear: overwrote role/index.json"]);
      expect(fs.readFileSync(path.join(dir, "role", "index.json"), "utf8")).toBe("[]\n");
      const none: string[] = [];
      writePolicyFiles(dir, [], (l) => none.push(l));
      expect(none[0]).toMatch(/no policies were exported/);
      writePolicyFiles(undefined, files, (l) => none.push(l));
      expect(none).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an escaping path writes nothing at all", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { writePolicyFiles } = await import("../src/policyfiles");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-files-"));
    try {
      expect(() => writePolicyFiles(dir, [{ path: "role/a.json", content: "{}\n" }, { path: "../x.json", content: "{}\n" }], () => {})).toThrow(/Refusing/);
      expect(fs.existsSync(path.join(dir, "role"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("an issued certificate needs nothing more", () => {
  const dnsSpec = { provider: "gandi", domain: "www.example.com", zone: "example.com" };
  const config = () => baseConfig({ resource: [], function: [], certificate: [{ provider: "aws", domain: "www.example.com", dns: dnsSpec, usage: "cdn" }] });
  const listed = (status: string) => ({
    ListCertificatesCommand: () => ({ CertificateSummaryList: [{ DomainName: "www.example.com", CertificateArn: "arn:aws:acm:us-east-1:1:certificate/c", Status: status, Type: "AMAZON_ISSUED" }] }),
    DescribeCertificateCommand: () => ({ Certificate: { DomainName: "www.example.com", Status: status } }),
  });

  test("applying an imported, issued certificate touches neither DNS nor ACM beyond reading it", async () => {
    const aws = fakeAws(listed("ISSUED"), null);
    const state = emptyState();
    await adoptEntries(plan(config(), state), state, aws.drivers, () => true);
    expect(plan(config(), state).every((a) => a.op === "noop" || a.op === "dry")).toBe(true);
    const moved = baseConfig({ resource: [], function: [], certificate: [{ provider: "aws", domain: "www.example.com", dns: { ...dnsSpec, zone: "other.example.com" }, usage: "cdn" }] });
    await apply(plan(moved, state), state, aws.drivers, { save: () => {} });
    expect(aws.of("RequestCertificateCommand")).toEqual([]);
    expect(aws.logs.some((l) => /is issued; nothing to do/.test(l))).toBe(true);
  });

  test("an imported, issued certificate that matches the config shows no update, but a different key algorithm still does", async () => {
    const aws = fakeAws({ ...listed("ISSUED"), ListCertificatesCommand: () => ({ CertificateSummaryList: [{ DomainName: "www.example.com", CertificateArn: "arn:aws:acm:us-east-1:1:certificate/c", Status: "ISSUED", Type: "AMAZON_ISSUED", KeyAlgorithm: "EC_prime256v1" }] }) }, null);
    const differing = emptyState();
    await adoptEntries(plan(config(), differing), differing, aws.drivers, () => true);
    expect(plan(config(), differing).find((a) => a.type === "@aws.Certificate")!.op).toBe("update");
    const ec = baseConfig({ resource: [], function: [], certificate: [{ provider: "aws", domain: "www.example.com", dns: dnsSpec, usage: "cdn", options: { key_algorithm: "EC_prime256v1" } }] });
    const matching = emptyState();
    await adoptEntries(plan(ec, matching), matching, aws.drivers, () => true);
    expect(plan(ec, matching).every((a) => a.op === "noop" || a.op === "dry")).toBe(true);
  });

  test("one still waiting for validation is validated as before", async () => {
    const aws = fakeAws(listed("PENDING_VALIDATION"), null);
    const state = emptyState();
    await adoptEntries(plan(config(), state), state, aws.drivers, () => true);
    await expect(apply(plan(config(), state), state, aws.drivers, { save: () => {} })).rejects.toThrow(/did not provide a DNS validation record/);
  });
});

describe("exporting a bucket's policy", () => {
  const config = () => baseConfig({ function: [], resource: [{ name: "data", type: "@aws.S3", physical_name: "data", dry: false, source: "a.ts:1" }] });
  const policy = { Version: "2012-10-17", Statement: [{ Sid: "PublicRead", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::data/*" }] };

  test("the bucket's policy is written as JSON next to the function policies", async () => {
    const aws = fakeAws({ HeadBucketCommand: () => ({}), GetBucketPolicyCommand: () => ({ Policy: JSON.stringify(policy) }) });
    const state = emptyState();
    const result = await adoptEntries(plan(config(), state), state, aws.drivers, everything, { exportPolicies: true });
    expect(result.files.map((f) => f.path)).toEqual(["buckets/data/policy.json"]);
    expect(JSON.parse(result.files[0]!.content)).toEqual(policy);
    expect(result.files[0]!.content.endsWith("\n")).toBe(true);
    expect(result.notes.join("\n")).toMatch(/bucket policy was exported/);
  });

  test("cloudgear's own CDN statements are left out of the export", async () => {
    const mixed = { ...policy, Statement: [...policy.Statement, { Sid: "cloudgear-cdn-example-read", Effect: "Allow", Principal: { Service: "cloudfront.amazonaws.com" }, Action: "s3:GetObject", Resource: "arn:aws:s3:::data/*" }] };
    const aws = fakeAws({ HeadBucketCommand: () => ({}), GetBucketPolicyCommand: () => ({ Policy: JSON.stringify(mixed) }) });
    const state = emptyState();
    const result = await adoptEntries(plan(config(), state), state, aws.drivers, everything, { exportPolicies: true });
    expect(JSON.parse(result.files[0]!.content)).toEqual(policy);
  });

  test("a bucket without a policy says so, and a policy that cannot be read is a note, not a failure", async () => {
    const none = fakeAws({ HeadBucketCommand: () => ({}), GetBucketPolicyCommand: () => { throw Object.assign(new Error("none"), { name: "NoSuchBucketPolicy" }); } });
    const state = emptyState();
    const absent = await adoptEntries(plan(config(), state), state, none.drivers, everything, { exportPolicies: true });
    expect(absent.files).toEqual([]);
    expect(absent.notes.join("\n")).toMatch(/has no bucket policy to export/);
    expect(absent.adopted).toEqual(["@aws.S3 data"]);
    const denied = fakeAws({ HeadBucketCommand: () => ({}), GetBucketPolicyCommand: () => { throw Object.assign(new Error("not allowed to s3:GetBucketPolicy"), { name: "AccessDenied" }); } });
    const fresh = emptyState();
    const refused = await adoptEntries(plan(config(), fresh), fresh, denied.drivers, everything, { exportPolicies: true });
    expect(refused.adopted).toEqual(["@aws.S3 data"]);
    expect(refused.notes.join("\n")).toMatch(/could not be exported \(not allowed to s3:GetBucketPolicy\)/);
  });

  test("nothing is read unless asked", async () => {
    const aws = fakeAws({ HeadBucketCommand: () => ({}) });
    const state = emptyState();
    await adoptEntries(plan(config(), state), state, aws.drivers, everything);
    expect(aws.of("GetBucketPolicyCommand")).toEqual([]);
  });
});
