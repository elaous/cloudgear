import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { syncAttached } from "../src/attached";
import { decodeConfig, encodeConfig } from "../src/config/schema";
import { adoptEntries } from "../src/deploy/adopt";
import { buildDistributionConfig, attachedOf } from "../src/deploy/aws/cloudfront";
import { plan, type CdnComparable } from "../src/deploy/plan";
import { configHash, envReportPath } from "../src/envreport";
import { baseConfig, emptyState, fakeAws, fn } from "./helpers";

const origin = { Id: "legacy-api", DomainName: "legacy.example.org", OriginPath: "", CustomOriginConfig: { HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: "https-only" } };
const behavior = { PathPattern: "/legacy/*", TargetOriginId: "legacy-api", ViewerProtocolPolicy: "https-only", CachePolicyId: "abc" };
const dnsSpec = { provider: "gandi", domain: "www.example.com", zone: "example.com" };

const withCdn = (attached?: ReturnType<typeof attachedOf>) =>
  baseConfig({
    resource: [{ name: "web", type: "@aws.S3", physical_name: "my-web", dry: false, source: "a.ts:1" }],
    function: [],
    certificate: [{ provider: "aws", domain: "www.example.com", dns: dnsSpec, usage: "cdn" }],
    cdn: [{ provider: "aws", domain: "www.example.com", bucket: "web", path: "", ...(attached ? { attached } : {}) }],
  });

const existing = (items: Record<string, unknown>[], behaviors: Record<string, unknown>[]) => ({
  ListDistributionsCommand: () => ({ DistributionList: { Items: [{ Id: "E1", ARN: "arn", DomainName: "d1.cloudfront.net", Status: "Deployed", Aliases: { Items: ["www.example.com"] } }] } }),
  GetDistributionConfigCommand: () => ({
    ETag: "e",
    DistributionConfig: {
      Origins: { Quantity: items.length, Items: items },
      CacheBehaviors: { Quantity: behaviors.length, Items: behaviors },
    },
  }),
});

const site = { Id: "S3-my-web", DomainName: "my-web.s3.eu-west-1.amazonaws.com" };

describe("attached origins", () => {
  test("importing a distribution keeps the origins reached by other path behaviors", async () => {
    const aws = fakeAws(existing([site, origin], [behavior]));
    const state = emptyState();
    const result = await adoptEntries(plan(withCdn(), state), state, aws.drivers, (a) => a.type === "@aws.CloudFront");
    const entry = Object.values(state.entries).find((e) => e.type === "@aws.CloudFront")!;
    const attached = (entry.spec as { attached: ReturnType<typeof attachedOf> }).attached;
    expect(attached).toHaveLength(1);
    expect(attached[0]!.id).toBe("legacy-api");
    expect(JSON.parse(attached[0]!.origin)).toEqual(origin);
    expect(JSON.parse(attached[0]!.behavior[0]!.behavior)).toEqual(behavior);
    const notes = result.notes.join("\n");
    expect(notes).toMatch(/1 other origin\(s\) \(legacy-api\) and 1 path behavior\(s\) are kept/);
    expect(notes).not.toMatch(/origin\(s\) will be replaced/);
    expect(notes).not.toMatch(/path behavior\(s\) will be replaced/);
  });

  test("an origin no behavior reaches is kept too, and the bucket's own origin is not", async () => {
    const unused = { Id: "old-lambda", DomainName: "abc.lambda-url.us-east-1.on.aws", OriginPath: "/api/items" };
    const aws = fakeAws(existing([site, unused], []));
    const state = emptyState();
    const result = await adoptEntries(plan(withCdn(), state), state, aws.drivers, (a) => a.type === "@aws.CloudFront");
    const entry = Object.values(state.entries).find((e) => e.type === "@aws.CloudFront")!;
    const attached = (entry.spec as { attached: ReturnType<typeof attachedOf> }).attached;
    expect(attached.map((a) => [a.id, a.behavior.length])).toEqual([["old-lambda", 0]]);
    expect(JSON.parse(attached[0]!.origin).OriginPath).toBe("/api/items");
    expect(result.notes.join("\n")).toMatch(/1 other origin\(s\) \(old-lambda\) and 0 path behavior\(s\) are kept/);
    expect(result.notes.join("\n")).not.toMatch(/will be replaced/);
  });

  test("the bucket's own origin is told apart by name, and kept when a path behavior of its own uses it", () => {
    const spec = { bucket: "web" } as unknown as CdnComparable;
    const origins = (...domains: string[]) => ({ Origins: { Items: domains.map((DomainName, i) => ({ Id: `o${i}`, DomainName })) } });
    const ids = (config: Record<string, unknown>) => attachedOf(config, spec).map((a) => a.id);
    expect(ids(origins("web.s3.us-east-1.amazonaws.com", "web.s3.amazonaws.com"))).toEqual([]);
    expect(ids(origins("web.example.com.s3.us-east-1.amazonaws.com", "web.s3-website-us-east-1.amazonaws.com", "other.example.org"))).toEqual(["o0", "o1", "o2"]);
    const used = { ...origins("web.s3.us-east-1.amazonaws.com", "web.s3.us-east-1.amazonaws.com"), CacheBehaviors: { Items: [{ PathPattern: "/img/*", TargetOriginId: "o1" }] } };
    expect(attachedOf(used, spec).map((a) => [a.id, a.behavior.map((b) => b.path_pattern)])).toEqual([["o1", ["/img/*"]]]);
  });

  test("a router CDN keeps a live S3 origin, and cloudgear's own origins count as replaced", async () => {
    const router = { bucket: "" } as unknown as CdnComparable;
    expect(attachedOf({ Origins: { Items: [{ Id: "s3", DomainName: "x.s3.us-east-1.amazonaws.com" }] } }, router).map((a) => a.id)).toEqual(["s3"]);
    const aws = fakeAws(existing([site, { Id: "cloudgear-fn-old", DomainName: "old.lambda-url.us-east-1.on.aws" }], [{ PathPattern: "/old", TargetOriginId: "cloudgear-fn-old" }]));
    const state = emptyState();
    const result = await adoptEntries(plan(withCdn(), state), state, aws.drivers, (a) => a.type === "@aws.CloudFront");
    expect(result.notes.join("\n")).toMatch(/1 origin\(s\) will be replaced/);
    expect(result.notes.join("\n")).toMatch(/1 path behavior\(s\) will be replaced/);
  });

  test("cloudgear's own origins and behaviors are never attached", () => {
    const config = {
      Origins: { Items: [{ Id: "cloudgear-site" }, { Id: "cloudgear-fn-a" }, origin] },
      CacheBehaviors: { Items: [{ PathPattern: "/a", TargetOriginId: "cloudgear-fn-a" }, { PathPattern: "/own", TargetOriginId: "legacy-api" }, behavior] },
    };
    const spec = { behaviors: [{ pattern: "/own", methods: ["GET"], function: "a" }] } as unknown as CdnComparable;
    expect(attachedOf(config, spec).flatMap((a) => a.behavior.map((b) => b.path_pattern))).toEqual(["/legacy/*"]);
  });

  test("attached origins are part of the distribution the config builds", () => {
    const attached = [{ id: "legacy-api", origin: JSON.stringify(origin), behavior: [{ path_pattern: "/legacy/*", behavior: JSON.stringify(behavior) }] }];
    const spec: CdnComparable = { domain: "www.example.com", dns_provider: "gandi", dns_zone: "example.com", bucket: "site", bucket_region: "", path: "", attached };
    const built = buildDistributionConfig(spec, { certificateArn: "arn", region: "us-east-1", oacS3: "oac", reference: "ref", enabled: true });
    expect(built.Origins!.Items!.map((o) => o.Id)).toEqual(["cloudgear-site", "legacy-api"]);
    expect(built.Origins!.Quantity).toBe(2);
    expect(built.CacheBehaviors!.Quantity).toBe(1);
    expect(built.CacheBehaviors!.Items![0]).toMatchObject(behavior as never);
  });

  test("an attached origin and behavior imported before CloudFront returned every member are completed", () => {
    const old = { Id: "legacy-api", DomainName: "legacy.example.org", CustomOriginConfig: { HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: "https-only", OriginReadTimeout: 60 } };
    const bare = { PathPattern: "/legacy/*", TargetOriginId: "legacy-api", ViewerProtocolPolicy: "https-only", FunctionAssociations: { Quantity: 1, Items: [{ EventType: "viewer-request", FunctionARN: "arn:fn" }] } };
    const attached = [{ id: "legacy-api", origin: JSON.stringify(old), behavior: [{ path_pattern: "/legacy/*", behavior: JSON.stringify(bare) }] }];
    const spec: CdnComparable = { domain: "www.example.com", dns_provider: "gandi", dns_zone: "example.com", bucket: "site", bucket_region: "", path: "", attached };
    const built = buildDistributionConfig(spec, { certificateArn: "arn", region: "us-east-1", oacS3: "oac", reference: "ref", enabled: true });
    expect(built.Origins!.Items![1]).toMatchObject({ CustomHeaders: { Quantity: 0 }, OriginShield: { Enabled: false }, ConnectionAttempts: 3, ConnectionTimeout: 10, CustomOriginConfig: { OriginReadTimeout: 60, OriginKeepaliveTimeout: 5, IpAddressType: "ipv4" } });
    expect(built.CacheBehaviors!.Items![0]).toMatchObject({ TrustedSigners: { Enabled: false, Quantity: 0 }, GrpcConfig: { Enabled: false }, SmoothStreaming: false, FunctionAssociations: { Quantity: 1 } });
  });

  test("the config file round-trips them and rejects JSON that disagrees with its id", () => {
    const attached = [{ id: "legacy-api", origin: JSON.stringify(origin), behavior: [{ path_pattern: "/legacy/*", behavior: JSON.stringify(behavior) }] }];
    const text = encodeConfig(withCdn(attached));
    expect(decodeConfig(text).cdn[0]!.attached).toEqual(attached);
    const wrongId = [{ ...attached[0]!, origin: JSON.stringify({ ...origin, Id: "other" }) }];
    expect(() => decodeConfig(encodeConfig(withCdn(wrongId)))).toThrow(/another Id/);
    const wrongTarget = [{ ...attached[0]!, behavior: [{ path_pattern: "/legacy/*", behavior: JSON.stringify({ ...behavior, TargetOriginId: "x" }) }] }];
    expect(() => decodeConfig(encodeConfig(withCdn(wrongTarget)))).toThrow(/targets another origin/);
    expect(() => decodeConfig(encodeConfig(withCdn([{ ...attached[0]!, origin: "not json" }])))).toThrow(/not a JSON object/);
  });

  test("the plan carries them, and refuses ids and patterns that clash", () => {
    const attached = [{ id: "legacy-api", origin: JSON.stringify(origin), behavior: [{ path_pattern: "/legacy/*", behavior: JSON.stringify(behavior) }] }];
    const cdn = plan(withCdn(attached), emptyState()).find((a) => a.type === "@aws.CloudFront")!;
    expect((cdn.desired!.spec as unknown as CdnComparable).attached).toEqual(attached);
    expect(() => plan(withCdn([{ ...attached[0]!, id: "cloudgear-site" }]), emptyState())).toThrow(/uses an id cloudgear keeps/);
    expect(() => plan(withCdn([attached[0]!, attached[0]!]), emptyState())).toThrow(/listed twice/);
    const second = { id: "b", origin: "{}", behavior: [attached[0]!.behavior[0]!] };
    expect(() => plan(withCdn([attached[0]!, second]), emptyState())).toThrow(/already used/);
  });

  test("behaviors keep their order across origins", async () => {
    const other = { ...origin, Id: "a-other" };
    const behaviors = [
      { PathPattern: "/api/v2/*", TargetOriginId: "legacy-api" },
      { PathPattern: "/api/*", TargetOriginId: "a-other" },
      { PathPattern: "/api/v2/x", TargetOriginId: "legacy-api" },
    ];
    const aws = fakeAws(existing([site, origin, other], behaviors));
    const state = emptyState();
    await adoptEntries(plan(withCdn(), state), state, aws.drivers, (a) => a.type === "@aws.CloudFront");
    const entry = Object.values(state.entries).find((e) => e.type === "@aws.CloudFront")!;
    const spec: CdnComparable = { domain: "www.example.com", dns_provider: "gandi", dns_zone: "example.com", bucket: "site", bucket_region: "", path: "", attached: (entry.spec as { attached: never }).attached };
    const built = buildDistributionConfig(spec, { certificateArn: "arn", region: "us-east-1", oacS3: "oac", reference: "ref", enabled: true });
    expect(built.CacheBehaviors!.Items!.map((b) => b.PathPattern)).toEqual(["/api/v2/*", "/api/*", "/api/v2/x"]);
  });

  test("an attached pattern that cloudgear's own pattern would shadow is refused", () => {
    const shadowed = { id: "legacy-api", origin: JSON.stringify(origin), behavior: [{ path_pattern: "/api/internal/*", behavior: JSON.stringify({ ...behavior, PathPattern: "/api/internal/*" }) }] };
    const config = baseConfig({
      resource: [],
      function: [fn({ permission: [], env: [], route: [{ name: "get", method: "GET", path: "/api/{id}" }] })],
      certificate: [{ provider: "aws", domain: "api.example.com", dns: { ...dnsSpec, domain: "api.example.com" }, usage: "cdn" }],
      api: { provider: "aws", domain: "api.example.com", via: "cloudfront", attached: [shadowed] },
    });
    expect(() => plan(config, emptyState())).toThrow(/shadowed by "\/api\/\*"/);
  });

  describe("written to the config on import", () => {
    let dir: string | undefined;
    afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

    const setup = (config: ReturnType<typeof withCdn>) => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-attached-"));
      const file = path.join(dir, "cloudgear.prototxt");
      const text = encodeConfig(config);
      fs.writeFileSync(file, text);
      fs.writeFileSync(envReportPath(file), JSON.stringify({ version: 1, config: configHash(text), functions: {} }));
      return file;
    };

    const imported = async () => {
      const aws = fakeAws(existing([site, origin], [behavior]));
      const state = emptyState();
      await adoptEntries(plan(withCdn(), state), state, aws.drivers, (a) => a.type === "@aws.CloudFront");
      return state;
    };

    test("the attached origins land in the config and the env report still matches it", async () => {
      const file = setup(withCdn());
      const sync = syncAttached(file, await imported());
      expect(sync).toEqual({ written: [`www.example.com: kept 1 attached origin(s) in ${file}`], problems: [] });
      const written = fs.readFileSync(file, "utf8");
      expect(decodeConfig(written).cdn[0]!.attached![0]!.id).toBe("legacy-api");
      expect(JSON.parse(fs.readFileSync(envReportPath(file), "utf8")).config).toBe(configHash(written));
      expect(written).toBe(encodeConfig(withCdn(decodeConfig(written).cdn[0]!.attached)));
    });

    test("a config that already lists attached origins is left alone", async () => {
      const mine = [{ id: "mine", origin: JSON.stringify({ ...origin, Id: "mine" }), behavior: [] }];
      const file = setup(withCdn(mine));
      const before = fs.readFileSync(file, "utf8");
      const sync = syncAttached(file, await imported());
      expect(sync.written).toEqual([]);
      expect(sync.problems.join("\n")).toMatch(/legacy-api will be removed by apply/);
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    });

    test("a config laid out by hand is reported, not silently left to lose the origins", async () => {
      const file = setup(withCdn());
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("cdn {", "cdn{"));
      const sync = syncAttached(file, await imported());
      expect(sync.written).toEqual([]);
      expect(sync.problems.join("\n")).toMatch(/could not be added .* not in the generated layout/);
    });

    test("an unreadable config is reported too", async () => {
      const file = setup(withCdn());
      fs.writeFileSync(file, "cdn {");
      expect((syncAttached(file, await imported())).problems.join("\n")).toMatch(/could not be read/);
    });
  });
});
