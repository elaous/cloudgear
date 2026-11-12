import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { MemoryDnsDriver } from "@cloudgear/dns/drivers/memory";
import { decodeConfig, type CloudgearConfig } from "../src/config/schema";
import { apply, endpointsFrom, hasEndpoints } from "../src/deploy/apply";
import { buildDistributionConfig, invalidateDistribution } from "../src/deploy/aws/cloudfront";
import { formatPlan, plan, type CdnComparable } from "../src/deploy/plan";
import { generate } from "../src/generate";
import { applyAll, baseConfig, emptyState, fakeAws, fn } from "./helpers";

const DOMAIN = "cdn.example.com";
const CERT_KEY = `@aws.Certificate.${DOMAIN}`;
const CDN_KEY = `@aws.CloudFront.${DOMAIN}`;

const dnsSpec = { provider: "gandi", domain: DOMAIN, zone: "example.com" };

const cdnConfig = (overrides: Partial<CloudgearConfig> = {}): CloudgearConfig => ({
  ...baseConfig(),
  certificate: [{ provider: "aws", domain: DOMAIN, dns: dnsSpec, usage: "cdn" }],
  cdn: [{ provider: "aws", domain: DOMAIN, bucket: "data", path: "web/" }],
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
    expect(order.indexOf(CDN_KEY)).toBeLessThan(order.indexOf(CERT_KEY));
    expect(order.indexOf("@aws.Lambda.foo")).toBeLessThan(order.indexOf("@aws.S3.data"));
    expect(order.indexOf(CDN_KEY)).toBeLessThan(order.indexOf("@aws.S3.data"));
  });

  test("a CDN without its certificate, or with an unknown bucket, is a config error", () => {
    expect(() => plan(cdnConfig({ certificate: [] }), emptyState())).toThrow(/cdn needs a certificate for "cdn.example.com"/);
    expect(() => plan(cdnConfig({ cdn: [{ ...cdnConfig().cdn[0]!, bucket: "nope" }] }), emptyState())).toThrow(/bucket "nope" is not a declared resource/);
    expect(() => plan(cdnConfig({ certificate: [{ provider: "aws", domain: DOMAIN, dns: dnsSpec, usage: "cdn", region: "eu-west-1" }] }), emptyState())).toThrow(/must be in us-east-1/);
  });

  test("a certificate can be planned without a CDN", () => {
    const actions = plan(cdnConfig({ cdn: [] }), emptyState());
    expect(actions.map((a) => a.key)).toContain(CERT_KEY);
    expect(actions.map((a) => a.key)).not.toContain(CDN_KEY);
  });

  test("a changed site path updates the CDN, and recreating a function does not touch it", async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    expect(plan(cdnConfig(), state).map((a) => a.op)).toEqual(["noop", "dry", "noop", "noop", "noop"]);
    const changed = cdnConfig({ cdn: [{ ...cdnConfig().cdn[0]!, path: "other/" }] });
    expect(plan(changed, state).find((a) => a.key === CDN_KEY)).toMatchObject({ op: "update", changes: ["spec"] });
    delete state.entries["@aws.Lambda.foo"];
    expect(plan(cdnConfig(), state).find((a) => a.key === CDN_KEY)!.op).toBe("noop");
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
    expect(aws.of("RequestCertificateCommand")).toEqual([{ DomainName: DOMAIN, ValidationMethod: "DNS" }]);
    expect(await aws.dns!.get("_v1.cdn.example.com", "CNAME")).toMatchObject({ values: ["_v2.acm-validations.aws."], ttl: 300 });
    expect(await aws.dns!.get(DOMAIN, "CNAME")).toMatchObject({ values: ["d111.cloudfront.net"] });

    expect(aws.of("CreateOriginAccessControlCommand").map((i) => i.OriginAccessControlConfig)).toMatchObject([
      { Name: `cloudgear-${DOMAIN}-s3`, OriginAccessControlOriginType: "s3", SigningBehavior: "always", SigningProtocol: "sigv4" },
    ]);

    expect(state.entries[CERT_KEY]!.outputs).toMatchObject({ arn: "arn:aws:acm:us-east-1:1:certificate/c1", validation_name: "_v1.cdn.example.com" });
    expect(state.entries[CDN_KEY]!.outputs).toMatchObject({
      id: "E1",
      arn: "arn:aws:cloudfront::1:distribution/E1",
      domain_name: "d111.cloudfront.net",
      status: "Deployed",
      oac_s3: "oac-s3",
    });
    expect(state.entries[CDN_KEY]!.deps).toEqual([CERT_KEY, "@aws.S3.data"]);
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
      /allowing the distribution to read data/,
      /pointing cdn\.example\.com at d111\.cloudfront\.net/,
      /waiting for the distribution to deploy/,
      /cdn\.example\.com is live/,
    ];
    const positions = steps.map((step) => aws.logs.findIndex((line) => step.test(line)));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("the distribution serves the site from the bucket", async () => {
    const aws = await applyAll(cdnConfig(), emptyState());
    const config = aws.of("CreateDistributionCommand")[0].DistributionConfig;

    expect(config).toMatchObject({
      Aliases: { Quantity: 1, Items: [DOMAIN] },
      DefaultRootObject: "index.html",
      Enabled: true,
      ViewerCertificate: { ACMCertificateArn: "arn:aws:acm:us-east-1:1:certificate/c1", SSLSupportMethod: "sni-only", MinimumProtocolVersion: "TLSv1.2_2021" },
    });
    expect(config.Origins.Items).toHaveLength(1);
    expect(config.Origins.Items[0]).toMatchObject({ Id: "cloudgear-site", DomainName: "data.s3.eu-west-1.amazonaws.com", OriginPath: "/web", OriginAccessControlId: "oac-s3" });
    expect(config.DefaultCacheBehavior).toMatchObject({ TargetOriginId: "cloudgear-site", ViewerProtocolPolicy: "redirect-to-https" });
    expect(config.CacheBehaviors).toEqual({ Quantity: 0, Items: [] });
  });

  test("the S3 origin uses the bucket's own region", async () => {
    const config = cdnConfig({
      resource: [{ name: "data", type: "@aws.S3", physical_name: "data", dry: false, source: "a.ts:1", region: "ap-southeast-2" }, ...baseConfig().resource.slice(1)],
    });
    const aws = await applyAll(config, emptyState());
    const [site] = aws.of("CreateDistributionCommand")[0].DistributionConfig.Origins.Items;
    expect(site.DomainName).toBe("data.s3.ap-southeast-2.amazonaws.com");
  });

  test("only this distribution may read the site", async () => {
    const aws = await applyAll(cdnConfig(), emptyState());
    const policy = JSON.parse(aws.of("PutBucketPolicyCommand")[0].Policy);
    const condition = { StringEquals: { "AWS:SourceArn": "arn:aws:cloudfront::1:distribution/E1" } };
    expect(policy.Statement).toEqual([
      expect.objectContaining({ Effect: "Allow", Principal: { Service: "cloudfront.amazonaws.com" }, Action: "s3:GetObject", Resource: "arn:aws:s3:::data/web/*", Condition: condition }),
    ]);
    expect(aws.of("AddPermissionCommand").filter((i) => i.Principal === "cloudfront.amazonaws.com")).toEqual([]);
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
    await applyAll({ ...cdnConfig(), cdn: [{ ...cdnConfig().cdn[0]!, path: "x/" }] }, state, aws);

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
    const changed = cdnConfig({ cdn: [{ ...cdnConfig().cdn[0]!, path: "other/" }] });
    const aws = await applyAll(changed, state);

    expect(aws.names()).not.toContain("CreateDistributionCommand");
    expect(aws.names()).not.toContain("CreateOriginAccessControlCommand");
    expect(aws.of("UpdateDistributionCommand")).toMatchObject([
      { Id: "E1", IfMatch: "e1", DistributionConfig: { CallerReference: "ref-1", Origins: { Items: [{ OriginPath: "/other" }] } } },
    ]);
  });

  test("destroying disables the distribution, waits, deletes it and cleans up after itself", async () => {
    const state = emptyState();
    const created = await applyAll(cdnConfig(), state);
    const policy = created.of("PutBucketPolicyCommand")[0].Policy;
    const aws = fakeAws({ GetBucketPolicyCommand: () => ({ Policy: policy }) }, created.dns);
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, aws);

    const names = aws.names();
    expect(names.filter((n) => !/Function|Role/.test(n)).slice(0, 6)).toEqual([
      "GetDistributionConfigCommand",
      "UpdateDistributionCommand",
      "GetDistributionCommand",
      "GetDistributionConfigCommand",
      "DeleteDistributionCommand",
      "GetOriginAccessControlCommand",
    ]);
    expect(aws.of("UpdateDistributionCommand")[0]).toMatchObject({ IfMatch: "e1", DistributionConfig: { Enabled: false } });
    expect(aws.of("DeleteDistributionCommand")).toEqual([{ Id: "E1", IfMatch: "e1" }]);
    expect(aws.of("DeleteOriginAccessControlCommand").map((i) => i.Id)).toEqual(["oac-s3"]);
    expect(names).toContain("DeleteBucketPolicyCommand");
    expect(await created.dns!.get(DOMAIN, "CNAME")).toBeNull();
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
    expect(state.entries[CDN_KEY]!.outputs).toMatchObject({ id: "E1", oac_s3: "oac-s3" });

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
        OriginAccessControlList: { Items: [{ Name: `cloudgear-${DOMAIN}-s3`, Id: "old-s3" }] },
      }),
    });
    const state = emptyState();
    await applyAll(cdnConfig(), state, aws);
    expect(state.entries[CDN_KEY]!.outputs).toMatchObject({ oac_s3: "old-s3" });
  });

  test("a CDN without a DNS driver fails with an explanation", async () => {
    await expect(applyAll(cdnConfig(), emptyState(), fakeAws({}, null))).rejects.toThrow(/A DNS driver is required/);
  });

  test("the function endpoints file is unaffected by the CDN", async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    expect(endpointsFrom(cdnConfig(), state).routes).toEqual({ "POST /foo/{param}": "https://app-foo.lambda-url.eu-west-1.on.aws/" });
  });

  test("a CDN without any routed function still has endpoints to write", async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    const siteOnly = cdnConfig({ function: [] });
    const endpoints = endpointsFrom(siteOnly, state);
    expect(endpoints.routes).toEqual({});
    expect(hasEndpoints(endpoints)).toBe(true);
    expect(hasEndpoints({ provider: "aws", routes: {} })).toBe(false);
  });

  test("the endpoints file also records the deployed distribution, once it exists", async () => {
    expect(endpointsFrom(cdnConfig(), emptyState()).cdn).toBeUndefined();
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    expect(state.entries[CDN_KEY]!.outputs.url).toBe("https://d111.cloudfront.net");
    expect(endpointsFrom(cdnConfig(), state).cdn).toEqual({ domain: DOMAIN, url: "https://d111.cloudfront.net", id: "E1" });
    delete state.entries[CDN_KEY]!.outputs.url;
    expect(endpointsFrom(cdnConfig(), state).cdn!.url).toBe("https://d111.cloudfront.net");
    expect(endpointsFrom(cdnConfig({ cdn: [] }), state).cdn).toBeUndefined();
  });
});

describe("a CDN deployed when it still routed to functions", () => {
  const legacy = async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    state.entries[CDN_KEY]!.outputs.oac_lambda = "oac-lambda";
    state.entries[CDN_KEY]!.spec = { ...state.entries[CDN_KEY]!.spec, behaviors: [{ path_pattern: "/foo/*", function: "app-foo", methods: ["GET"] }] };
    return state;
  };
  const statements = (aws: Awaited<ReturnType<typeof applyAll>>) => aws.of("RemovePermissionCommand").filter((i) => /cloudgear-cdn/.test(i.StatementId));

  test("the next update removes its Lambda origin access control and function permissions", async () => {
    const state = await legacy();
    const aws = await applyAll(cdnConfig({ cdn: [{ ...cdnConfig().cdn[0]!, path: "other/" }] }), state);
    expect(aws.of("DeleteOriginAccessControlCommand").map((i) => i.Id)).toEqual(["oac-lambda"]);
    expect(statements(aws).map((i) => [i.FunctionName, i.StatementId.replace(/^cloudgear-cdn-[0-9a-f]+-/, "")])).toEqual([["app-foo", "url"], ["app-foo", "invoke"]]);
    expect(state.entries[CDN_KEY]!.outputs.oac_lambda).toBe("");
  });

  test("destroying it removes both origin access controls and the permissions", async () => {
    const state = await legacy();
    const aws = fakeAws({});
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, aws);
    expect(aws.of("DeleteOriginAccessControlCommand").map((i) => i.Id)).toEqual(["oac-s3", "oac-lambda"]);
    expect(statements(aws)).toHaveLength(2);
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
    await applyAll(cdnConfig({ cdn: [], certificate: [{ provider: "aws", domain: DOMAIN, dns: dnsSpec }] }), emptyState(), aws);
    expect(aws.names()).toContain("RequestCertificateCommand");
    expect(await dns.get(DOMAIN, "CNAME")).toMatchObject({ values: ["old-site.example.net."] });
  });

  test("the distribution's own check still protects a certificate that already exists", async () => {
    const state = emptyState();
    await applyAll(cdnConfig({ cdn: [] }), state);
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

  test("deleting a CDN whose create failed part-way still removes its bucket policy", async () => {
    const state = emptyState();
    let policy = "";
    const failing = fakeAws({
      PutBucketPolicyCommand: (input) => void (policy = input.Policy),
      GetDistributionCommand: () => {
        throw error("AccessDenied", "cannot read the distribution");
      },
    });
    await expect(applyAll(cdnConfig(), state, failing)).rejects.toThrow("cannot read the distribution");
    expect(state.entries[CDN_KEY]!.spec).toMatchObject({ incomplete: true, bucket: "data" });

    const cleanup = fakeAws({ GetBucketPolicyCommand: () => ({ Policy: policy }) });
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, cleanup);
    expect(cleanup.names()).toContain("DeleteBucketPolicyCommand");
  });

  test("an update that fails keeps the outputs it produced and is marked incomplete", async () => {
    const state = emptyState();
    await applyAll(cdnConfig(), state);
    const next = cdnConfig({ cdn: [{ ...cdnConfig().cdn[0]!, path: "other/" }] });
    const failing = fakeAws({
      UpdateDistributionCommand: () => {
        throw error("InvalidArgument", "bad config");
      },
    });
    await expect(applyAll(next, state, failing)).rejects.toThrow("bad config");
    expect(state.entries[CDN_KEY]!.outputs).toMatchObject({ id: "E1", oac_s3: "oac-s3" });
    expect(state.entries[CDN_KEY]!.spec).toMatchObject({ incomplete: true, previous: { path: "web/" } });

    const resumed = await applyAll(next, state);
    expect(resumed.names()).not.toContain("CreateOriginAccessControlCommand");
    expect(state.entries[CDN_KEY]!.spec).not.toHaveProperty("incomplete");
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
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, aws);
    expect(opened.length).toBeGreaterThan(0);
    expect(new Set(opened.map((o) => o.join("/")))).toEqual(new Set(["gandi/example.com"]));
    expect(state.entries).toEqual({});
  });

  test("origin access controls are found on later pages and get names within CloudFront's limit", async () => {
    const long = "a-very-long-subdomain-name-for-a-site.deeply.nested.example.com";
    const config = cdnConfig({
      certificate: [{ provider: "aws", domain: long, dns: { ...dnsSpec, domain: long }, usage: "cdn" }],
      cdn: [{ ...cdnConfig().cdn[0]!, domain: long }],
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
    await applyAll(cdnConfig({ cdn: [] }), state, aws);
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
    await expect(applyAll(cdnConfig({ cdn: [] }), state, failing)).rejects.toThrow(/ended as FAILED/);
    expect(state.entries[CERT_KEY]).toMatchObject({ spec: { incomplete: true }, outputs: { arn: "arn:aws:acm:us-east-1:1:certificate/c1" } });

    const resumed = await applyAll(cdnConfig({ cdn: [] }), state);
    expect(resumed.names()).not.toContain("RequestCertificateCommand");
    expect(state.entries[CERT_KEY]!.spec).not.toHaveProperty("incomplete");
  });

  test("an identical validation record is reused, a different one is a conflict", async () => {
    const dns = new MemoryDnsDriver();
    await dns.upsert({ name: "_v1.cdn.example.com", type: "CNAME", values: ["_v2.acm-validations.aws"], ttl: 300 });
    const reuse = fakeAws({}, dns);
    await applyAll(cdnConfig({ cdn: [] }), emptyState(), reuse);
    expect(await dns.get("_v1.cdn.example.com", "CNAME")).toMatchObject({ values: ["_v2.acm-validations.aws"] });

    const other = new MemoryDnsDriver();
    await other.upsert({ name: "_v1.cdn.example.com", type: "CNAME", values: ["somewhere.else."], ttl: 300 });
    await expect(applyAll(cdnConfig({ cdn: [] }), emptyState(), fakeAws({}, other))).rejects.toThrow(/already exists with a different value \(somewhere\.else\.\)/);
  });

  test("never being issued times out with the record to check", async () => {
    const state = emptyState();
    const aws = fakeAws({
      DescribeCertificateCommand: () => ({
        Certificate: { Status: "PENDING_VALIDATION", DomainValidationOptions: [{ ResourceRecord: { Name: "_v1.cdn.example.com.", Value: "_v2." } }] },
      }),
    });
    await expect(applyAll(cdnConfig({ cdn: [] }), state, aws)).rejects.toThrow(/Timed out waiting for certificate .* _v1\.cdn\.example\.com/);
  });

  test("ACM never offering a validation record is an error", async () => {
    const aws = fakeAws({ DescribeCertificateCommand: () => ({ Certificate: { Status: "PENDING_VALIDATION", DomainValidationOptions: [{}] } }) });
    await expect(applyAll(cdnConfig({ cdn: [] }), emptyState(), aws)).rejects.toThrow(/did not provide a DNS validation record/);
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
  test("a distribution has the bucket as its only origin and no extra behaviors", () => {
    const spec: CdnComparable = { domain: DOMAIN, dns_provider: "gandi", dns_zone: "example.com", bucket: "site", bucket_region: "", path: "" };
    const config = buildDistributionConfig(spec, {
      certificateArn: "arn",
      region: "us-east-1",
      oacS3: "oac",
      reference: "ref",
      enabled: true,
    });
    expect(config.Origins!.Quantity).toBe(1);
    expect(config.Origins!.Items![0]).toMatchObject({ DomainName: "site.s3.us-east-1.amazonaws.com", OriginPath: "" });
    expect(config.CacheBehaviors).toEqual({ Quantity: 0, Items: [] });
  });

  test("the defaults UpdateDistribution insists on are always sent, and the price class option wins", () => {
    const base: CdnComparable = { domain: DOMAIN, dns_provider: "gandi", dns_zone: "example.com", bucket: "site", bucket_region: "", path: "" };
    const input = { certificateArn: "arn", region: "us-east-1", oacS3: "oac", reference: "ref", enabled: true };
    const config = buildDistributionConfig(base, input);
    expect(config.PriceClass).toBe("PriceClass_All");
    expect(config.Logging).toEqual({ Enabled: false, IncludeCookies: false, Bucket: "", Prefix: "" });
    expect(config.Restrictions).toEqual({ GeoRestriction: { RestrictionType: "none", Quantity: 0 } });
    expect(config.CustomErrorResponses).toEqual({ Quantity: 0 });
    expect(config.OriginGroups).toEqual({ Quantity: 0 });
    expect(config.DefaultRootObject).toBe("index.html");
    // Every member a console-made distribution returns, so UpdateDistribution has nothing to call missing.
    for (const key of ["Aliases", "DefaultRootObject", "OriginGroups", "CacheBehaviors", "CustomErrorResponses", "Logging", "PriceClass", "Restrictions", "WebACLId", "HttpVersion", "IsIPV6Enabled", "Origins", "DefaultCacheBehavior", "ViewerCertificate", "Comment", "Enabled", "CallerReference"]) {
      expect(config).toHaveProperty(key);
    }
    expect(config.Origins!.Items![0]).toMatchObject({ CustomHeaders: { Quantity: 0 }, OriginShield: { Enabled: false }, ConnectionAttempts: 3, ConnectionTimeout: 10 });
    expect(config.DefaultCacheBehavior).toMatchObject({ TrustedSigners: { Enabled: false, Quantity: 0 }, TrustedKeyGroups: { Enabled: false, Quantity: 0 }, LambdaFunctionAssociations: { Quantity: 0 }, FunctionAssociations: { Quantity: 0 }, SmoothStreaming: false, FieldLevelEncryptionId: "" });
    const router: CdnComparable = { ...base, bucket: "", behaviors: [] };
    expect(buildDistributionConfig(router, input).DefaultRootObject).toBe("");
    expect(buildDistributionConfig({ ...base, options: { price_class: "PriceClass_100" } }, input).PriceClass).toBe("PriceClass_100");
  });

  test("origins and behaviors carry every member CloudFront returns for them, as UpdateDistribution requires", () => {
    const input = { certificateArn: "arn", region: "us-east-1", oacS3: "oac", oacLambda: "oacl", reference: "ref", enabled: true };
    const bucket: CdnComparable = { domain: DOMAIN, dns_provider: "gandi", dns_zone: "example.com", bucket: "site", bucket_region: "", path: "" };
    const router: CdnComparable = { domain: DOMAIN, dns_provider: "gandi", dns_zone: "example.com", bucket: "", bucket_region: "", path: "", behaviors: [{ pattern: "/x", methods: ["GET"], function: "f" }] };
    const common = ["Id", "DomainName", "OriginPath", "CustomHeaders", "ConnectionAttempts", "ConnectionTimeout", "OriginShield", "OriginAccessControlId"];
    const behavior = ["TargetOriginId", "ViewerProtocolPolicy", "TrustedSigners", "TrustedKeyGroups", "AllowedMethods", "SmoothStreaming", "Compress", "LambdaFunctionAssociations", "FunctionAssociations", "FieldLevelEncryptionId", "CachePolicyId", "GrpcConfig"];
    const site = buildDistributionConfig(bucket, input);
    expect(Object.keys(site.Origins!.Items![0]!)).toEqual(expect.arrayContaining([...common, "S3OriginConfig"]));
    expect(site.Origins!.Items![0]!.S3OriginConfig).toEqual({ OriginAccessIdentity: "", OriginReadTimeout: 30 });
    expect(Object.keys(site.DefaultCacheBehavior!)).toEqual(expect.arrayContaining(behavior));
    const functions = buildDistributionConfig(router, { ...input, origins: new Map([["f", { physical: "f", host: "f.lambda-url.us-east-1.on.aws" }]]) as never });
    expect(Object.keys(functions.Origins!.Items![0]!)).toEqual(expect.arrayContaining([...common, "CustomOriginConfig"]));
    expect(Object.keys(functions.Origins!.Items![0]!.CustomOriginConfig!)).toEqual(expect.arrayContaining(["HTTPPort", "HTTPSPort", "OriginProtocolPolicy", "OriginSslProtocols", "OriginReadTimeout", "OriginKeepaliveTimeout", "IpAddressType"]));
    expect(Object.keys(functions.DefaultCacheBehavior!)).toEqual(expect.arrayContaining(behavior));
    expect(Object.keys(functions.CacheBehaviors!.Items![0]!)).toEqual(expect.arrayContaining([...behavior, "PathPattern"]));
  });

  test("a web ACL given as an option is attached, and none is set when it is not", () => {
    const base: CdnComparable = { domain: DOMAIN, dns_provider: "gandi", dns_zone: "example.com", bucket: "site", bucket_region: "", path: "" };
    const input = { certificateArn: "arn", region: "us-east-1", oacS3: "oac", reference: "ref", enabled: true };
    const acl = "arn:aws:wafv2:us-east-1:111122223333:global/webacl/mine/b576f740-7bb3-4e5f-849b-af9d3c2b0c27";
    expect(buildDistributionConfig({ ...base, options: { web_acl: acl } }, input).WebACLId).toBe(acl);
    expect(buildDistributionConfig(base, input).WebACLId).toBe("");
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

describe("several CDNs in one app", () => {
  const site = (domain: string, bucket: string) => ({ provider: "aws", domain, bucket, path: "" });
  const certFor = (domain: string) => ({ provider: "aws", domain, dns: dnsSpec, usage: "cdn" as const });
  const many = () =>
    baseConfig({
      resource: ["files", "web", "admin"].map((name) => ({ name, type: "@aws.S3", physical_name: `my-${name}`, dry: false, source: "a.ts:1" })),
      function: [],
      certificate: ["files.example.com", "www.example.com", "admin.example.com"].map(certFor),
      cdn: [site("files.example.com", "files"), site("www.example.com", "web"), site("admin.example.com", "admin")],
    });

  test("every site gets its own certificate, distribution and bucket policy", async () => {
    const state = emptyState();
    const aws = await applyAll(many(), state);
    expect(aws.of("CreateDistributionCommand")).toHaveLength(3);
    expect(aws.of("RequestCertificateCommand")).toHaveLength(3);
    expect(aws.of("PutBucketPolicyCommand").map((p) => p.Bucket).sort()).toEqual(["my-admin", "my-files", "my-web"]);
    expect(Object.keys(state.entries).filter((key) => key.startsWith("@aws.CloudFront."))).toHaveLength(3);
  });

  test("an unchanged app plans nothing, and removing one site removes only its distribution", async () => {
    const state = emptyState();
    await applyAll(many(), state);
    expect(plan(many(), state).every((a) => a.op === "noop" || a.op === "dry")).toBe(true);
    const fewer = many();
    fewer.cdn = fewer.cdn.filter((c) => c.domain !== "admin.example.com");
    fewer.certificate = fewer.certificate.filter((c) => c.domain !== "admin.example.com");
    const deleted = plan(fewer, state).filter((a) => a.op === "delete").map((a) => a.name);
    expect(deleted.sort()).toEqual(["admin.example.com", "admin.example.com"]);
  });

  test("the endpoints file lists every deployed site by domain, and the first as cdn", async () => {
    const state = emptyState();
    await applyAll(many(), state);
    const endpoints = endpointsFrom(many(), state);
    expect(Object.keys(endpoints.cdns ?? {}).sort()).toEqual(["admin.example.com", "files.example.com", "www.example.com"]);
    expect(endpoints.cdn?.domain).toBe("files.example.com");
    expect(endpointsFrom({ ...many(), cdn: [site("files.example.com", "files")] }, state).cdns).toBeUndefined();
  });

  test("the first declared site is `cdn` only once it is deployed, and cdns lists the deployed ones", async () => {
    const state = emptyState();
    await applyAll(many(), state);
    delete state.entries["@aws.CloudFront.files.example.com"];
    const endpoints = endpointsFrom(many(), state);
    expect(endpoints.cdn).toBeUndefined();
    expect(Object.keys(endpoints.cdns ?? {}).sort()).toEqual(["admin.example.com", "www.example.com"]);
    expect(hasEndpoints(endpoints)).toBe(true);
  });

  describe("two sites on one bucket", () => {
    const shared = () =>
      baseConfig({
        resource: [{ name: "web", type: "@aws.S3", physical_name: "my-web", dry: false, source: "a.ts:1" }],
        function: [],
        certificate: ["www.example.com", "admin.example.com"].map(certFor),
        cdn: [{ ...site("www.example.com", "web"), path: "public/" }, { ...site("admin.example.com", "web"), path: "admin/" }],
      });
    const bucket = () => {
      let policy: string | undefined;
      return fakeAws({
        GetBucketPolicyCommand: () => {
          if (!policy) throw Object.assign(new Error("no policy"), { name: "NoSuchBucketPolicy" });
          return { Policy: policy };
        },
        PutBucketPolicyCommand: (input: { Policy: string }) => void (policy = input.Policy),
        DeleteBucketPolicyCommand: () => void (policy = undefined),
      });
    };
    const statements = (aws: { of: (n: string) => any[] }) => JSON.parse(aws.of("PutBucketPolicyCommand").at(-1).Policy).Statement as { Sid: string; Resource: string }[];

    test("each site keeps its own statement, scoped to its path", async () => {
      const aws = bucket();
      await applyAll(shared(), emptyState(), aws);
      const last = statements(aws);
      expect(new Set(last.map((s) => s.Sid)).size).toBe(2);
      expect(last.map((s) => s.Resource).sort()).toEqual(["arn:aws:s3:::my-web/admin/*", "arn:aws:s3:::my-web/public/*"]);
    });

    test("removing one site leaves the other's statement and does not delete the policy", async () => {
      const aws = bucket();
      const state = emptyState();
      await applyAll(shared(), state, aws);
      const fewer = shared();
      fewer.cdn = fewer.cdn.filter((c) => c.domain === "www.example.com");
      fewer.certificate = fewer.certificate.filter((c) => c.domain === "www.example.com");
      await applyAll(fewer, state, aws);
      expect(aws.of("DeleteBucketPolicyCommand")).toEqual([]);
      expect(statements(aws).map((s) => s.Resource)).toEqual(["arn:aws:s3:::my-web/public/*"]);
    });

    test("removing the last site deletes the policy", async () => {
      const aws = bucket();
      const state = emptyState();
      await applyAll(shared(), state, aws);
      await applyAll(baseConfig({ resource: [], function: [] }), state, aws);
      expect(aws.of("DeleteBucketPolicyCommand")).toEqual([{ Bucket: "my-web" }]);
    });
  });
});

describe("sites on a wildcard certificate", () => {
  const wildcard = { provider: "aws", domain: "*.example.com", dns: { provider: "gandi", domain: "*.example.com", zone: "example.com" }, usage: "cdn" as const };
  const site = (host: string, bucket: string) => ({ provider: "aws", domain: host, certificate: "*.example.com", bucket, path: "" });
  const config = () =>
    baseConfig({
      resource: ["files", "web"].map((name) => ({ name, type: "@aws.S3", physical_name: `my-${name}`, dry: false, source: "a.ts:1" })),
      function: [],
      certificate: [wildcard],
      cdn: [site("files.example.com", "files"), site("www.example.com", "web")],
    });

  test("one certificate serves every site, each distribution answers to its own hostname", async () => {
    const dns = new MemoryDnsDriver();
    const state = emptyState();
    const aws = await applyAll(config(), state, fakeAws({}, dns));
    expect(aws.of("RequestCertificateCommand")).toMatchObject([{ DomainName: "*.example.com" }]);
    const created = aws.of("CreateDistributionCommand").map((c) => c.DistributionConfig);
    expect(created.map((d) => d.Aliases.Items).sort()).toEqual([["files.example.com"], ["www.example.com"]]);
    expect(created.every((d) => d.ViewerCertificate.ACMCertificateArn === "arn:aws:acm:us-east-1:1:certificate/c1")).toBe(true);
    expect((await dns.get("files.example.com", "CNAME"))?.values).toEqual(["d111.cloudfront.net"]);
    expect((await dns.get("www.example.com", "CNAME"))?.values).toEqual(["d111.cloudfront.net"]);
    expect(Object.keys(state.entries).filter((key) => key.startsWith("@aws.Certificate."))).toEqual(["@aws.Certificate.*.example.com"]);
  });

  test("an unchanged app plans nothing, and the distributions go before the certificate on removal", async () => {
    const state = emptyState();
    await applyAll(config(), state, fakeAws({}, new MemoryDnsDriver()));
    expect(plan(config(), state).every((a) => a.op === "noop" || a.op === "dry")).toBe(true);
    const aws = fakeAws({}, new MemoryDnsDriver());
    await applyAll(baseConfig({ resource: [], function: [] }), state, aws);
    const names = aws.names();
    expect(names.lastIndexOf("DeleteDistributionCommand")).toBeLessThan(names.indexOf("DeleteCertificateCommand"));
    expect(aws.of("DeleteCertificateCommand")).toHaveLength(1);
  });

  test("generate writes the wildcard and each hostname, and plan wires the router's CDN to the same certificate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wildcard-"));
    try {
      const { config: generated } = await generate({ entry: path.join(import.meta.dir, "fixtures", "router", "edge", "wildcard.ts"), configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "app" });
      expect(generated.certificate).toMatchObject([{ domain: "*.example.com", usage: "cdn" }]);
      expect(generated.cdn.map((c) => [c.domain, c.certificate])).toEqual([["files.example.com", "*.example.com"], ["www.example.com", "*.example.com"]]);
      expect(generated.api).toMatchObject({ domain: "api.example.com", certificate: "*.example.com", via: "cloudfront" });
      const decoded = decodeConfig(fs.readFileSync(path.join(dir, "c.prototxt"), "utf8"));
      expect(decoded.cdn).toEqual(generated.cdn);
      expect(decoded.api).toEqual(generated.api);
      const entries = plan(decoded, emptyState());
      expect(entries.filter((a) => a.type === "@aws.Certificate").map((a) => a.name)).toEqual(["*.example.com"]);
      expect(entries.filter((a) => a.type === "@aws.CloudFront").map((a) => a.name).sort()).toEqual(["api.example.com", "files.example.com", "www.example.com"]);
      const spec = (name: string) => entries.find((a) => a.type === "@aws.CloudFront" && a.name === name)!.desired!.spec as { certificate_domain?: string };
      expect(["api.example.com", "files.example.com", "www.example.com"].map((n) => spec(n).certificate_domain)).toEqual(["*.example.com", "*.example.com", "*.example.com"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hand-edited config whose certificate does not cover the host is refused", () => {
    const bad = config();
    bad.cdn = [{ ...site("a.b.example.com", "files") }];
    expect(() => plan(bad, emptyState())).toThrow(/does not cover the CDN's domain "a\.b\.example\.com"/);
    const api = { ...config(), api: { provider: "aws", domain: "a.b.example.com", certificate: "*.example.com", via: "cloudfront" as const } };
    expect(() => plan(api, emptyState())).toThrow(/does not cover the API's domain/);
  });

  test("an exact certificate leaves certificate_domain out of the spec", () => {
    const exact = baseConfig({
      resource: [{ name: "files", type: "@aws.S3", physical_name: "my-files", dry: false, source: "a.ts:1" }],
      function: [],
      certificate: [{ provider: "aws", domain: "www.example.com", dns: { provider: "gandi", domain: "www.example.com", zone: "example.com" }, usage: "cdn" }],
      cdn: [{ provider: "aws", domain: "www.example.com", bucket: "files", path: "" }],
    });
    const spec = plan(exact, emptyState()).find((a) => a.type === "@aws.CloudFront")!.desired!.spec;
    expect(Object.hasOwn(spec, "certificate_domain")).toBe(false);
  });

  test("a foreign record on one served hostname fails that distribution, not the certificate", async () => {
    const dns = new MemoryDnsDriver();
    await dns.upsert({ name: "files.example.com", type: "CNAME", values: ["elsewhere.example.net."], ttl: 300 });
    const aws = fakeAws({}, dns);
    await expect(applyAll(config(), emptyState(), aws)).rejects.toThrow(/DNS record files\.example\.com already exists/);
    expect(aws.of("RequestCertificateCommand")).toHaveLength(1);
    expect(aws.of("CreateDistributionCommand")).toEqual([]);
  });

  test("a wildcard certificate does not look up a record named after the wildcard", async () => {
    const dns = new MemoryDnsDriver();
    await dns.upsert({ name: "foreign.example.com", type: "CNAME", values: ["x.example.net."], ttl: 300 });
    const aws = fakeAws({}, dns);
    await applyAll(baseConfig({ function: [], resource: [], certificate: [wildcard] }), emptyState(), aws);
    expect(aws.of("RequestCertificateCommand")).toHaveLength(1);
  });
});

describe("a web ACL on a distribution", () => {
  const acl = "arn:aws:wafv2:us-east-1:111122223333:global/webacl/mine/b576f740-7bb3-4e5f-849b-af9d3c2b0c27";
  const withAcl = (on: boolean) => cdnConfig({ cdn: [{ ...cdnConfig().cdn[0]!, ...(on ? { options: { web_acl: acl } } : {}) }] });

  test("adding the option to a deployed CDN is an update, and so is taking it away; the update carries the ACL", async () => {
    const state = emptyState();
    await applyAll(withAcl(false), state);
    expect(plan(withAcl(false), state).every((a) => a.op === "noop" || a.op === "dry")).toBe(true);
    const adding = plan(withAcl(true), state).find((a) => a.type === "@aws.CloudFront")!;
    expect(adding).toMatchObject({ op: "update", changes: ["spec"] });
    const added = fakeAws();
    await apply(plan(withAcl(true), state), state, added.drivers, { save: () => {} });
    expect(added.of("UpdateDistributionCommand").at(-1).DistributionConfig.WebACLId).toBe(acl);
    expect(plan(withAcl(true), state).every((a) => a.op === "noop" || a.op === "dry")).toBe(true);
    const removing = plan(withAcl(false), state).find((a) => a.type === "@aws.CloudFront")!;
    expect(removing).toMatchObject({ op: "update", changes: ["spec"] });
    const removed = fakeAws();
    await apply(plan(withAcl(false), state), state, removed.drivers, { save: () => {} });
    expect(removed.of("UpdateDistributionCommand").at(-1).DistributionConfig.WebACLId).toBe("");
  });

  test("a new distribution is created with the ACL attached", async () => {
    const aws = await applyAll(withAcl(true), emptyState());
    expect(aws.of("CreateDistributionCommand")[0].DistributionConfig.WebACLId).toBe(acl);
  });

  test("web_acl: true keeps whatever ACL the distribution has, and a classic id too", async () => {
    const keep = cdnConfig({ cdn: [{ ...cdnConfig().cdn[0]!, options: { web_acl: "true" } }] });
    const state = emptyState();
    const created = await applyAll(keep, state);
    expect(created.of("CreateDistributionCommand")[0].DistributionConfig.WebACLId).toBe("");
    for (const [current, price_class] of [[acl, "PriceClass_100"], ["a1b2c3d4-0000-1111-2222-333344445555", "PriceClass_200"]] as const) {
      const changed = cdnConfig({ cdn: [{ ...keep.cdn[0]!, options: { web_acl: "true", price_class } }] });
      const aws = fakeAws({ GetDistributionConfigCommand: () => ({ ETag: "e", DistributionConfig: { CallerReference: "ref", WebACLId: current } }) });
      await apply(plan(changed, state), state, aws.drivers, { save: () => {} });
      expect(aws.of("UpdateDistributionCommand").at(-1).DistributionConfig.WebACLId).toBe(current);
    }
  });

  test("the router's distribution takes the option too, and a bad ARN there is refused", () => {
    const router = (web_acl: string) => baseConfig({
      resource: [],
      function: [fn({ permission: [], env: [] })],
      certificate: [{ provider: "aws", domain: DOMAIN, dns: dnsSpec, usage: "cdn" }],
      api: { provider: "aws", domain: DOMAIN, via: "cloudfront", options: { web_acl } },
    });
    const entry = plan(router(acl), emptyState()).find((a) => a.type === "@aws.CloudFront")!;
    expect((entry.desired!.spec as unknown as CdnComparable).options).toEqual({ web_acl: acl });
    const built = buildDistributionConfig(entry.desired!.spec as unknown as CdnComparable, { certificateArn: "arn", region: "us-east-1", reference: "ref", enabled: true });
    expect(built.WebACLId).toBe(acl);
    expect(() => plan(router("not-an-arn"), emptyState())).toThrow(/WAFv2 web ACL ARN in us-east-1/);
  });
});
