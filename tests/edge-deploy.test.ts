import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { MemoryDnsDriver } from "@cloudgear/dns/drivers/memory";
import type { CloudgearConfig } from "../src/config/schema";
import { apply, endpointsFrom } from "../src/deploy/apply";
import { awsDrivers } from "../src/deploy/aws";
import { allowedMethods, buildDistributionConfig, invalidateDistribution } from "../src/deploy/aws/cloudfront";
import { formatPlan, plan, type CdnComparable } from "../src/deploy/plan";
import type { State } from "../src/deploy/state";
import { applyAll, baseConfig, emptyState, fakeAws } from "./helpers";

const DOMAIN = "cdn.example.com";
const CERT_KEY = `@aws.Certificate.${DOMAIN}`;
const CDN_KEY = `@aws.CloudFront.${DOMAIN}`;

const cdnConfig = (overrides: Partial<CloudgearConfig> = {}): CloudgearConfig => ({
  ...baseConfig(),
  dns: { provider: "gandi", domain: DOMAIN, zone: "example.com" },
  certificate: { domain: DOMAIN },
  cdn: {
    provider: "aws",
    domain: DOMAIN,
    bucket: "data",
    path: "web/",
    behavior: [{ path_pattern: "/foo/*", function: "foo", method: ["POST", "GET"] }],
  },
  ...overrides,
});

const error = (name: string, message = name) => Object.assign(new Error(message), { name });

describe("planning the edge", () => {
  test("applies the certificate and CDN after what they depend on, deletes them first", () => {
    const created = plan(cdnConfig(), emptyState());
    expect(created.map((a) => a.key)).toEqual(["@aws.S3.data", "@aws.S3.legacy", "@aws.Lambda.foo", CERT_KEY, CDN_KEY]);
    expect(created.map((a) => a.op)).toEqual(["create", "dry", "create", "create", "create"]);
    expect(formatPlan(created)).toContain(`+ @aws.CloudFront ${DOMAIN}`);

    const state = emptyState();
    for (const action of created) {
      if (action.op === "create") {
        state.entries[action.key] = { ...action.desired!, outputs: {}, spec: action.desired!.spec } as never;
      }
    }
    const removal = plan({ ...baseConfig(), resource: [], function: [] }, state);
    expect(removal.every((a) => a.op === "delete")).toBe(true);
    const order = removal.map((a) => a.key);
    expect(order).toHaveLength(4);
    // dependents go before what they depend on
    expect(order[0]).toBe(CDN_KEY);
    expect(order.indexOf(CDN_KEY)).toBeLessThan(order.indexOf(CERT_KEY));
    expect(order.indexOf(CDN_KEY)).toBeLessThan(order.indexOf("@aws.Lambda.foo"));
    expect(order.indexOf("@aws.Lambda.foo")).toBeLessThan(order.indexOf("@aws.S3.data"));
    expect(order.indexOf(CDN_KEY)).toBeLessThan(order.indexOf("@aws.S3.data"));
  });

  test("a CDN without a certificate or dns is a config error", () => {
    expect(() => plan(cdnConfig({ certificate: undefined }), emptyState())).toThrow(/cdn needs dns and certificate/);
    expect(() => plan(cdnConfig({ dns: undefined }), emptyState())).toThrow(/needs dns/);
    expect(() => plan(cdnConfig({ cdn: { ...cdnConfig().cdn!, bucket: "nope" } }), emptyState())).toThrow(/bucket "nope" is not a declared resource/);
  });

  test("a certificate can be planned without a CDN", () => {
    const actions = plan(cdnConfig({ cdn: undefined }), emptyState());
    expect(actions.map((a) => a.key)).toContain(CERT_KEY);
    expect(actions.map((a) => a.key)).not.toContain(CDN_KEY);
  });

  test("the CDN is refreshed when a function it serves is created again", async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    expect(plan(cdnConfig(), state).map((a) => a.op)).toEqual(["noop", "dry", "noop", "noop", "noop"]);

    delete state.entries["@aws.Lambda.foo"];
    const actions = plan(cdnConfig(), state);
    expect(actions.find((a) => a.key === "@aws.Lambda.foo")!.op).toBe("create");
    expect(actions.find((a) => a.key === CDN_KEY)).toMatchObject({ op: "update", changes: ["dependencies"] });
  });

  test("changed behaviors update the CDN", async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    const changed = cdnConfig({ cdn: { ...cdnConfig().cdn!, behavior: [{ path_pattern: "/bar/*", function: "foo", method: ["GET"] }] } });
    expect(plan(changed, state).find((a) => a.key === CDN_KEY)).toMatchObject({ op: "update", changes: ["spec"] });
  });
});

describe("applying the edge", () => {
  test("creates certificate, origin access controls, distribution, policies and DNS records in order", async () => {
    const state = emptyState();
    const aws = await applyAll(cdnConfig(), state);

    const names = aws.names();
    const order = ["RequestCertificateCommand", "CreateOriginAccessControlCommand", "CreateDistributionCommand", "PutBucketPolicyCommand", "GetDistributionCommand"];
    expect(order.map((n) => names.indexOf(n))).toEqual([...order.map((n) => names.indexOf(n))].sort((a, b) => a - b));
    expect(order.every((n) => names.includes(n))).toBe(true);
    // the Lambda is created before anything that needs its URL
    expect(names.indexOf("CreateFunctionUrlConfigCommand")).toBeLessThan(names.indexOf("CreateDistributionCommand"));

    expect(aws.of("RequestCertificateCommand")).toEqual([{ DomainName: DOMAIN, ValidationMethod: "DNS" }]);
    expect(await aws.dns!.get("_v1.cdn.example.com", "CNAME")).toMatchObject({ values: ["_v2.acm-validations.aws."], ttl: 300 });
    expect(await aws.dns!.get(DOMAIN, "CNAME")).toMatchObject({ values: ["d111.cloudfront.net"] });

    expect(aws.of("CreateOriginAccessControlCommand").map((i) => i.OriginAccessControlConfig)).toMatchObject([
      { Name: `cloudgear-${DOMAIN}-s3`, OriginAccessControlOriginType: "s3", SigningBehavior: "always", SigningProtocol: "sigv4" },
      { Name: `cloudgear-${DOMAIN}-lambda`, OriginAccessControlOriginType: "lambda" },
    ]);

    expect(state.entries[CERT_KEY]!.outputs).toMatchObject({ arn: "arn:aws:acm:us-east-1:1:certificate/c1", validation_name: "_v1.cdn.example.com" });
    expect(state.entries[CDN_KEY]!.outputs).toMatchObject({
      id: "E1",
      arn: "arn:aws:cloudfront::1:distribution/E1",
      domain_name: "d111.cloudfront.net",
      status: "Deployed",
      oac_s3: "oac-s3",
      oac_lambda: "oac-lambda",
    });
    expect(state.entries[CDN_KEY]!.deps).toEqual([CERT_KEY, "@aws.S3.data", "@aws.Lambda.foo"]);
  });

  test("each step is reported, in order, as it happens", async () => {
    const aws = await applyAll(cdnConfig(), emptyState());
    const steps = [
      /requested a certificate for cdn\.example\.com/,
      /waiting for ACM's DNS validation record/,
      /wrote validation record _v1\.cdn\.example\.com/,
      /waiting for the certificate to be issued/,
      /certificate issued/,
      /creating origin access controls/,
      /creating the distribution for cdn\.example\.com/,
      /distribution E1 will be served from d111\.cloudfront\.net/,
      /allowing the distribution to read data and call 1 function\(s\)/,
      /pointing cdn\.example\.com at d111\.cloudfront\.net/,
      /waiting for the distribution to deploy/,
      /cdn\.example\.com is live/,
    ];
    const positions = steps.map((step) => aws.logs.findIndex((line) => step.test(line)));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("the distribution serves the site from the bucket and routes to the function", async () => {
    const aws = await applyAll(cdnConfig(), emptyState());
    const config = aws.of("CreateDistributionCommand")[0].DistributionConfig;

    expect(config).toMatchObject({
      Aliases: { Quantity: 1, Items: [DOMAIN] },
      DefaultRootObject: "index.html",
      Enabled: true,
      ViewerCertificate: { ACMCertificateArn: "arn:aws:acm:us-east-1:1:certificate/c1", SSLSupportMethod: "sni-only", MinimumProtocolVersion: "TLSv1.2_2021" },
    });
    const [site, fn] = config.Origins.Items;
    expect(site).toMatchObject({ Id: "cloudgear-site", DomainName: "data.s3.eu-west-1.amazonaws.com", OriginPath: "/web", OriginAccessControlId: "oac-s3" });
    expect(fn).toMatchObject({
      DomainName: "app-foo.lambda-url.eu-west-1.on.aws",
      OriginAccessControlId: "oac-lambda",
      CustomOriginConfig: { OriginProtocolPolicy: "https-only" },
    });
    expect(config.DefaultCacheBehavior).toMatchObject({ TargetOriginId: "cloudgear-site", ViewerProtocolPolicy: "redirect-to-https" });
    expect(config.CacheBehaviors.Items).toEqual([
      expect.objectContaining({
        PathPattern: "/foo/*",
        TargetOriginId: "cloudgear-fn-app-foo",
        AllowedMethods: expect.objectContaining({ Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"] }),
        CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
        OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
      }),
    ]);
  });

  test("only this distribution may read the site and call the function", async () => {
    const aws = await applyAll(cdnConfig(), emptyState());
    const policy = JSON.parse(aws.of("PutBucketPolicyCommand")[0].Policy);
    const condition = { StringEquals: { "AWS:SourceArn": "arn:aws:cloudfront::1:distribution/E1" } };
    // reading objects is all the CDN needs, and only under the site's path
    expect(policy.Statement).toEqual([
      expect.objectContaining({ Effect: "Allow", Principal: { Service: "cloudfront.amazonaws.com" }, Action: "s3:GetObject", Resource: "arn:aws:s3:::data/web/*", Condition: condition }),
    ]);

    const grants = aws.of("AddPermissionCommand").filter((i) => i.Principal === "cloudfront.amazonaws.com");
    expect(grants).toMatchObject([
      { FunctionName: "app-foo", Action: "lambda:InvokeFunctionUrl", SourceArn: "arn:aws:cloudfront::1:distribution/E1", FunctionUrlAuthType: "AWS_IAM" },
      { FunctionName: "app-foo", Action: "lambda:InvokeFunction", SourceArn: "arn:aws:cloudfront::1:distribution/E1", InvokedViaFunctionUrl: true },
    ]);
  });

  test("existing bucket policy statements are kept and the CDN's are not duplicated", async () => {
    const foreign = { Sid: "other", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::data/public/*" };
    let stored = JSON.stringify({ Version: "2012-10-17", Statement: [foreign] });
    const aws = fakeAws({
      GetBucketPolicyCommand: () => ({ Policy: stored }),
      PutBucketPolicyCommand: (input) => void (stored = input.Policy),
    });
    const state = emptyState();
    await applyAll(cdnConfig(), state, aws);
    await applyAll({ ...cdnConfig(), cdn: { ...cdnConfig().cdn!, behavior: [{ path_pattern: "/x/*", function: "foo", method: ["GET"] }] } }, state, aws);

    const sids = JSON.parse(stored).Statement.map((s: { Sid: string }) => s.Sid);
    expect(sids).toHaveLength(2);
    expect(sids[0]).toBe("other");
  });

  test("a ListBucket statement written by an earlier version is removed on the next apply", async () => {
    const id = createHash("sha256").update(DOMAIN).digest("hex").slice(0, 12);
    const old = [
      { Sid: "other", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::data/public/*" },
      { Sid: `cloudgear-cdn-${id}-read`, Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::data/web/*" },
      { Sid: `cloudgear-cdn-${id}-list`, Effect: "Allow", Action: "s3:ListBucket", Resource: "arn:aws:s3:::data" },
    ];
    let stored = JSON.stringify({ Version: "2012-10-17", Statement: old });
    const aws = fakeAws({ GetBucketPolicyCommand: () => ({ Policy: stored }), PutBucketPolicyCommand: (input) => void (stored = input.Policy) });
    await applyAll(cdnConfig(), emptyState(), aws);
    expect(JSON.parse(stored).Statement.map((s: { Sid: string }) => s.Sid)).toEqual(["other", `cloudgear-cdn-${id}-read`]);
  });

  test("updating reuses the distribution with its caller reference and etag", async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    const changed = cdnConfig({ cdn: { ...cdnConfig().cdn!, behavior: [{ path_pattern: "/bar/*", function: "foo", method: ["GET"] }] } });
    const aws = await applyAll(changed, state);

    expect(aws.names()).not.toContain("CreateDistributionCommand");
    expect(aws.names()).not.toContain("CreateOriginAccessControlCommand");
    expect(aws.of("UpdateDistributionCommand")).toMatchObject([
      { Id: "E1", IfMatch: "e1", DistributionConfig: { CallerReference: "ref-1", CacheBehaviors: { Items: [{ PathPattern: "/bar/*" }] } } },
    ]);
  });

  test("destroying disables the distribution, waits, deletes it and cleans up after itself", async () => {
    const state = emptyState();
    const created = await applyAll(cdnConfig(), state);
    let policy = created.of("PutBucketPolicyCommand")[0].Policy;
    const aws = fakeAws({ GetBucketPolicyCommand: () => ({ Policy: policy }) }, created.dns);
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, aws);

    const names = aws.names();
    expect(names.slice(0, 6)).toEqual([
      "GetDistributionConfigCommand",
      "UpdateDistributionCommand",
      "GetDistributionCommand",
      "GetDistributionConfigCommand",
      "DeleteDistributionCommand",
      "GetOriginAccessControlCommand",
    ]);
    expect(aws.of("UpdateDistributionCommand")[0]).toMatchObject({ IfMatch: "e1", DistributionConfig: { Enabled: false } });
    expect(aws.of("DeleteDistributionCommand")).toEqual([{ Id: "E1", IfMatch: "e1" }]);
    expect(aws.of("DeleteOriginAccessControlCommand").map((i) => i.Id)).toEqual(["oac-s3", "oac-lambda"]);
    expect(names).toContain("DeleteBucketPolicyCommand");
    expect(aws.of("RemovePermissionCommand").filter((i) => /cloudgear-cdn/.test(i.StatementId))).toHaveLength(2);
    expect(await created.dns!.get(DOMAIN, "CNAME")).toBeNull();
    // the certificate's validation record stays: ACM shares it between certificates for a domain
    expect(await created.dns!.get("_v1.cdn.example.com", "CNAME")).not.toBeNull();
    expect(aws.of("DeleteCertificateCommand")).toEqual([{ CertificateArn: "arn:aws:acm:us-east-1:1:certificate/c1" }]);
    expect(names.indexOf("DeleteDistributionCommand")).toBeLessThan(names.indexOf("DeleteCertificateCommand"));
    expect(state.entries).toEqual({});
  });

  test("a distribution that is still disabling stops the destroy with a clear message", async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    const aws = fakeAws({ GetDistributionCommand: () => ({ Distribution: { Status: "InProgress" } }) });
    await expect(applyAll({ ...baseConfig(), resource: [], function: [] }, state, aws)).rejects.toThrow(/still being disabled; run apply again/);
    expect(state.entries[CDN_KEY]).toBeDefined();
    expect(aws.sleeps.length).toBeGreaterThan(100);
  });

  test("a slow deployment is not an error; the status says so", async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state, fakeAws({ GetDistributionCommand: () => ({ Distribution: { Status: "InProgress" } }) }));
    expect(state.entries[CDN_KEY]!.outputs.status).toBe("InProgress");
  });

  test("a failure after the distribution exists keeps it in state and the next apply resumes", async () => {
    const state = emptyState();
    const broken = fakeAws({
      PutBucketPolicyCommand: () => {
        throw error("AccessDenied", "bucket policy denied");
      },
    });
    await expect(applyAll(cdnConfig(), state, broken)).rejects.toThrow("bucket policy denied");
    expect(state.entries[CDN_KEY]!.spec).toMatchObject({ incomplete: true, bucket: "data" });
    expect(state.entries[CDN_KEY]!.outputs).toMatchObject({ id: "E1", oac_s3: "oac-s3", oac_lambda: "oac-lambda" });

    const next = plan(cdnConfig(), state).find((a) => a.key === CDN_KEY)!;
    expect(next.op).toBe("update");
    const resumed = await applyAll(cdnConfig(), state);
    expect(resumed.names()).not.toContain("CreateDistributionCommand");
    expect(resumed.names()).not.toContain("CreateOriginAccessControlCommand");
    expect(resumed.of("UpdateDistributionCommand")).toHaveLength(1);
    expect(state.entries[CDN_KEY]!.spec).not.toHaveProperty("incomplete");
    expect(state.entries[CDN_KEY]!.outputs.status).toBe("Deployed");
  });

  test("a failure before anything exists leaves nothing half-recorded", async () => {
    const state = emptyState();
    const aws = fakeAws({
      CreateOriginAccessControlCommand: () => {
        throw error("AccessDenied");
      },
    });
    await expect(applyAll(cdnConfig(), state, aws)).rejects.toThrow("AccessDenied");
    expect(state.entries[CDN_KEY]).toBeUndefined();
  });

  test("an origin access control that already exists is looked up and reused", async () => {
    const aws = fakeAws({
      CreateOriginAccessControlCommand: () => {
        throw error("OriginAccessControlAlreadyExists");
      },
      ListOriginAccessControlsCommand: () => ({
        OriginAccessControlList: { Items: [{ Name: `cloudgear-${DOMAIN}-s3`, Id: "old-s3" }, { Name: `cloudgear-${DOMAIN}-lambda`, Id: "old-fn" }] },
      }),
    });
    const state = emptyState();
    await applyAll(cdnConfig(), state, aws);
    expect(state.entries[CDN_KEY]!.outputs).toMatchObject({ oac_s3: "old-s3", oac_lambda: "old-fn" });
  });

  test("a CDN without a DNS driver fails with an explanation", async () => {
    await expect(applyAll(cdnConfig(), emptyState(), fakeAws({}, null))).rejects.toThrow(/A DNS driver is required/);
  });

  test("the function endpoints file is unaffected by the CDN", async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    expect(endpointsFrom(cdnConfig(), state).routes).toEqual({ "POST /foo/{param}": "https://app-foo.lambda-url.eu-west-1.on.aws/" });
  });
});

describe("records and cleanup the CDN does not own", () => {
  const foreign = { name: DOMAIN, type: "CNAME" as const, values: ["old-site.example.net."], ttl: 300 };

  test("an existing record for the domain stops the apply before the certificate is requested", async () => {
    const dns = new MemoryDnsDriver();
    await dns.upsert(foreign);
    const aws = fakeAws({}, dns);
    await expect(applyAll(cdnConfig(), emptyState(), aws)).rejects.toThrow(/DNS record cdn\.example\.com already exists \(CNAME old-site\.example\.net\.\)/);
    expect(aws.names()).not.toContain("RequestCertificateCommand");
    expect(aws.names()).not.toContain("CreateDistributionCommand");
    expect(aws.names()).not.toContain("CreateOriginAccessControlCommand");
    expect(await dns.get(DOMAIN, "CNAME")).toMatchObject({ values: ["old-site.example.net."] });
  });

  test("a certificate on its own does not mind a record for the domain", async () => {
    const dns = new MemoryDnsDriver();
    await dns.upsert(foreign);
    const aws = fakeAws({}, dns);
    await applyAll(cdnConfig({ cdn: undefined }), emptyState(), aws);
    expect(aws.names()).toContain("RequestCertificateCommand");
    expect(await dns.get(DOMAIN, "CNAME")).toMatchObject({ values: ["old-site.example.net."] });
  });

  test("the distribution's own check still protects a certificate that already exists", async () => {
    const state = emptyState();
    await applyAll(cdnConfig({ cdn: undefined }), state);
    const dns = new MemoryDnsDriver();
    await dns.upsert(foreign);
    const aws = fakeAws({}, dns);
    await expect(applyAll(cdnConfig(), state, aws)).rejects.toThrow(/already exists \(CNAME old-site/);
    expect(aws.names()).not.toContain("CreateDistributionCommand");
    expect(aws.names()).not.toContain("CreateOriginAccessControlCommand");
  });

  test("destroy leaves a record that no longer points at the distribution", async () => {
    const state = emptyState();
    const created = await applyAll(cdnConfig(), state);
    await created.dns!.upsert({ ...foreign });
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, fakeAws({}, created.dns));
    expect(await created.dns!.get(DOMAIN, "CNAME")).toMatchObject({ values: ["old-site.example.net."] });
  });

  test("a distribution that was never created owns no record, so destroy leaves it alone", async () => {
    const state = emptyState();
    const dns = new MemoryDnsDriver();
    const failing = fakeAws(
      {
        CreateDistributionCommand: () => {
          throw error("CNAMEAlreadyExists", "domain is used by another distribution");
        },
      },
      dns,
    );
    await expect(applyAll(cdnConfig(), state, failing)).rejects.toThrow("another distribution");
    await dns.upsert({ ...foreign });
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, fakeAws({}, dns));
    expect(await dns.get(DOMAIN, "CNAME")).toMatchObject({ values: ["old-site.example.net."] });
  });

  test("deleting a CDN whose create failed part-way still removes its bucket policy and permissions", async () => {
    const state = emptyState();
    let policy = "";
    const failing = fakeAws({
      PutBucketPolicyCommand: (input) => void (policy = input.Policy),
      AddPermissionCommand: (input) => {
        if (input.Principal === "cloudfront.amazonaws.com") throw error("AccessDeniedException", "cannot grant");
      },
    });
    await expect(applyAll(cdnConfig(), state, failing)).rejects.toThrow("cannot grant");
    expect(state.entries[CDN_KEY]!.spec).toMatchObject({ incomplete: true, bucket: "data", behaviors: [{ function: "app-foo" }] });

    const cleanup = fakeAws({ GetBucketPolicyCommand: () => ({ Policy: policy }) });
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, cleanup);
    expect(cleanup.names()).toContain("DeleteBucketPolicyCommand");
    expect(cleanup.of("RemovePermissionCommand").filter((i) => /cloudgear-cdn/.test(i.StatementId))).toHaveLength(2);
  });

  test("an update that fails keeps the outputs it produced and is marked incomplete", async () => {
    const state = emptyState();
    await applyAll(cdnConfig({ function: [] , cdn: { ...cdnConfig().cdn!, behavior: [] } }), state);
    expect(state.entries[CDN_KEY]!.outputs.oac_lambda).toBeUndefined();

    // the function arrives later; creating its origin access control succeeds, then the update fails
    const next = cdnConfig();
    const failing = fakeAws({
      UpdateDistributionCommand: () => {
        throw error("InvalidArgument", "bad config");
      },
    });
    await expect(applyAll(next, state, failing)).rejects.toThrow("bad config");
    expect(state.entries[CDN_KEY]!.outputs.oac_lambda).toBe("oac-lambda");
    expect(state.entries[CDN_KEY]!.spec).toMatchObject({ incomplete: true });

    const resumed = await applyAll(next, state);
    expect(resumed.names()).not.toContain("CreateOriginAccessControlCommand");
    expect(state.entries[CDN_KEY]!.spec).not.toHaveProperty("incomplete");
  });

  test("permissions of a function dropped by a failed update are still revoked on retry and on destroy", async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    const dropped = cdnConfig({ cdn: { ...cdnConfig().cdn!, behavior: [] } });

    const failing = fakeAws({
      UpdateDistributionCommand: () => {
        throw error("InvalidArgument", "bad config");
      },
    });
    await expect(applyAll(dropped, state, failing)).rejects.toThrow("bad config");
    expect(state.entries[CDN_KEY]!.spec).toMatchObject({ incomplete: true, behaviors: [], previous: { behaviors: [{ function: "app-foo" }] } });

    const retry = await applyAll(dropped, state);
    expect(retry.of("RemovePermissionCommand").filter((i) => /cloudgear-cdn/.test(i.StatementId))).toHaveLength(2);
    expect(state.entries[CDN_KEY]!.spec).not.toHaveProperty("previous");

    // and a destroy after another failed update still knows what the distribution had been granted
    const again = emptyState();
    await applyAll(cdnConfig(), again);
    await expect(applyAll(dropped, again, failing)).rejects.toThrow();
    const gone = fakeAws({});
    await applyAll({ ...baseConfig(), resource: [], function: [] }, again, gone);
    expect(gone.of("RemovePermissionCommand").filter((i) => /cloudgear-cdn/.test(i.StatementId))).toHaveLength(2);
  });

  test("a distribution that vanished while disabling is not an error", async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    let reads = 0;
    const aws = fakeAws({
      GetDistributionConfigCommand: () => {
        if (++reads === 2) throw error("NoSuchDistribution");
        return { ETag: "e1", DistributionConfig: { CallerReference: "r", Enabled: true } };
      },
    });
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, aws);
    expect(aws.names()).not.toContain("DeleteDistributionCommand");
    expect(state.entries).toEqual({});
  });

  test("entries clean up through the DNS provider and zone recorded in their own spec", async () => {
    const state = emptyState();
    const created = await applyAll(cdnConfig(), state);
    const opened: [string, string][] = [];
    const aws = fakeAws({}, created.dns, (provider, zone) => void opened.push([provider, zone]));
    // the declarations are gone from the config, but the state still knows where the records live
    await applyAll({ ...baseConfig(), resource: [], function: [], dns: undefined, certificate: undefined, cdn: undefined }, state, aws);
    expect(opened.length).toBeGreaterThan(0);
    expect(new Set(opened.map((o) => o.join("/")))).toEqual(new Set(["gandi/example.com"]));
    expect(state.entries).toEqual({});
  });

  test("origin access controls are found on later pages and get names within CloudFront's limit", async () => {
    const long = "a-very-long-subdomain-name-for-a-site.deeply.nested.example.com";
    const config = cdnConfig({
      dns: { provider: "gandi", domain: long, zone: "example.com" },
      certificate: { domain: long },
      cdn: { ...cdnConfig().cdn!, domain: long },
    });
    const pages: string[] = [];
    const aws = fakeAws({
      CreateOriginAccessControlCommand: () => {
        throw error("OriginAccessControlAlreadyExists");
      },
      ListOriginAccessControlsCommand: (input) => {
        pages.push(input.Marker ?? "first");
        return input.Marker
          ? { OriginAccessControlList: { Items: [{ Name: "ignored", Id: "x" }] } }
          : { OriginAccessControlList: { Items: [], IsTruncated: true, NextMarker: "m1" } };
      },
    });
    await expect(applyAll(config, emptyState(), aws)).rejects.toThrow("OriginAccessControlAlreadyExists");
    expect(pages).toEqual(["first", "m1"]);
    const created = aws.of("CreateOriginAccessControlCommand").map((i) => i.OriginAccessControlConfig.Name as string);
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((name) => name.length <= 64)).toBe(true);
  });

  test("the ETag used to delete is fetched after the distribution finished disabling", async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    let reads = 0;
    const aws = fakeAws({ GetDistributionConfigCommand: () => ({ ETag: `etag-${++reads}`, DistributionConfig: { CallerReference: "r", Enabled: reads === 1 } }) });
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, aws);
    expect(aws.of("DeleteDistributionCommand")).toEqual([{ Id: "E1", IfMatch: "etag-2" }]);
  });
});

describe("certificate", () => {
  const stateWithCertificate = async (overrides: Parameters<typeof fakeAws>[0] = {}) => {
    const state = emptyState();
    const aws = fakeAws(overrides);
    await applyAll(cdnConfig({ cdn: undefined }), state, aws);
    return { state, aws };
  };

  test("waits for the validation record and for issuance", async () => {
    let described = 0;
    const { aws, state } = await stateWithCertificate({
      DescribeCertificateCommand: () => {
        described++;
        if (described === 1) return { Certificate: { Status: "PENDING_VALIDATION", DomainValidationOptions: [{}] } };
        if (described < 5) return { Certificate: { Status: "PENDING_VALIDATION", DomainValidationOptions: [{ ResourceRecord: { Name: "_v1.cdn.example.com.", Value: "_v2.acm." } }] } };
        return { Certificate: { Status: "ISSUED", DomainValidationOptions: [] } };
      },
    });
    expect(described).toBe(5);
    expect(aws.sleeps.length).toBeGreaterThanOrEqual(3);
    expect(await aws.dns!.get("_v1.cdn.example.com", "CNAME")).toMatchObject({ values: ["_v2.acm."] });
    expect(state.entries[CERT_KEY]!.outputs.arn).toBeDefined();
  });

  test("a failed validation keeps the certificate in state and the next apply continues it", async () => {
    const state = emptyState();
    const failing = fakeAws({
      DescribeCertificateCommand: () => ({
        Certificate: { Status: "FAILED", DomainValidationOptions: [{ ResourceRecord: { Name: "_v1.cdn.example.com.", Value: "_v2." } }] },
      }),
    });
    await expect(applyAll(cdnConfig({ cdn: undefined }), state, failing)).rejects.toThrow(/ended as FAILED/);
    expect(state.entries[CERT_KEY]).toMatchObject({ spec: { incomplete: true }, outputs: { arn: "arn:aws:acm:us-east-1:1:certificate/c1" } });

    const resumed = await applyAll(cdnConfig({ cdn: undefined }), state);
    expect(resumed.names()).not.toContain("RequestCertificateCommand");
    expect(state.entries[CERT_KEY]!.spec).not.toHaveProperty("incomplete");
  });

  test("an identical validation record is reused, a different one is a conflict", async () => {
    const dns = new MemoryDnsDriver();
    await dns.upsert({ name: "_v1.cdn.example.com", type: "CNAME", values: ["_v2.acm-validations.aws"], ttl: 300 });
    const reuse = fakeAws({}, dns);
    await applyAll(cdnConfig({ cdn: undefined }), emptyState(), reuse);
    expect(await dns.get("_v1.cdn.example.com", "CNAME")).toMatchObject({ values: ["_v2.acm-validations.aws"] });

    const other = new MemoryDnsDriver();
    await other.upsert({ name: "_v1.cdn.example.com", type: "CNAME", values: ["somewhere.else."], ttl: 300 });
    await expect(applyAll(cdnConfig({ cdn: undefined }), emptyState(), fakeAws({}, other))).rejects.toThrow(/already exists with a different value \(somewhere\.else\.\)/);
  });

  test("never being issued times out with the record to check", async () => {
    const state = emptyState();
    const aws = fakeAws({
      DescribeCertificateCommand: () => ({
        Certificate: { Status: "PENDING_VALIDATION", DomainValidationOptions: [{ ResourceRecord: { Name: "_v1.cdn.example.com.", Value: "_v2." } }] },
      }),
    });
    await expect(applyAll(cdnConfig({ cdn: undefined }), state, aws)).rejects.toThrow(/Timed out waiting for certificate .* _v1\.cdn\.example\.com/);
  });

  test("ACM never offering a validation record is an error", async () => {
    const aws = fakeAws({ DescribeCertificateCommand: () => ({ Certificate: { Status: "PENDING_VALIDATION", DomainValidationOptions: [{}] } }) });
    await expect(applyAll(cdnConfig({ cdn: undefined }), emptyState(), aws)).rejects.toThrow(/did not provide a DNS validation record/);
  });

  test("deleting leaves the validation record in place", async () => {
    const { state, aws } = await stateWithCertificate();
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, fakeAws({}, aws.dns));
    expect(await aws.dns!.get("_v1.cdn.example.com", "CNAME")).not.toBeNull();
  });

  test("deleting retries while CloudFront still holds the certificate", async () => {
    const { state } = await stateWithCertificate();
    let attempts = 0;
    const aws = fakeAws({
      DeleteCertificateCommand: () => {
        if (++attempts < 3) throw error("ResourceInUseException");
      },
    });
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, aws);
    expect(attempts).toBe(3);
    expect(state.entries[CERT_KEY]).toBeUndefined();
  });

  test("deleting gives up when the certificate stays in use, and tolerates one already gone", async () => {
    const { state } = await stateWithCertificate();
    const stuck = fakeAws({
      DeleteCertificateCommand: () => {
        throw error("ResourceInUseException");
      },
    });
    await expect(applyAll({ ...baseConfig(), resource: [], function: [] }, state, stuck)).rejects.toThrow("ResourceInUseException");
    expect(state.entries[CERT_KEY]).toBeDefined();

    const gone = fakeAws({
      DeleteCertificateCommand: () => {
        throw error("ResourceNotFoundException");
      },
    });
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, gone);
    expect(state.entries[CERT_KEY]).toBeUndefined();
  });
});

describe("CloudFront configuration", () => {
  test("allowedMethods picks one of the three sets CloudFront accepts", () => {
    expect(allowedMethods(["GET"])).toEqual(["GET", "HEAD"]);
    expect(allowedMethods(["GET", "HEAD"])).toEqual(["GET", "HEAD"]);
    expect(allowedMethods(["GET", "OPTIONS"])).toEqual(["GET", "HEAD", "OPTIONS"]);
    expect(allowedMethods(["GET", "POST"])).toEqual(["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]);
    expect(allowedMethods(["DELETE"])).toHaveLength(7);
  });

  test("a bucket-only distribution has no function origins or behaviors", () => {
    const spec: CdnComparable = { domain: DOMAIN, dns_provider: "gandi", dns_zone: "example.com", bucket: "site", path: "", behaviors: [] };
    const config = buildDistributionConfig(spec, {
      certificateArn: "arn",
      region: "us-east-1",
      oacS3: "oac",
      origins: new Map(),
      reference: "ref",
      enabled: true,
    });
    expect(config.Origins!.Quantity).toBe(1);
    expect(config.Origins!.Items![0]).toMatchObject({ DomainName: "site.s3.us-east-1.amazonaws.com", OriginPath: "" });
    expect(config.CacheBehaviors).toEqual({ Quantity: 0, Items: [] });
  });

  test("invalidateDistribution sends the paths and returns the id", async () => {
    const sent: any[] = [];
    const id = await invalidateDistribution(
      { send: async (command: any) => (sent.push(command.input), { Invalidation: { Id: "I9" } }) },
      "E1",
      ["/index.html", "/app/*"],
    );
    expect(id).toBe("I9");
    expect(sent[0]).toMatchObject({ DistributionId: "E1", InvalidationBatch: { Paths: { Quantity: 2, Items: ["/index.html", "/app/*"] } } });
  });
});
