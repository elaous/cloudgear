import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Timeout covers analysis and bundling.
setDefaultTimeout(30_000);

const root = path.join(import.meta.dir, "..");
const entry = path.join(root, "examples", "router-app", "main.ts");

describe("cloudgear CLI", () => {
  let dir: string;
  const config = () => path.join(dir, "cloudgear.prototxt");
  const run = (...args: string[]) => {
    const proc = Bun.spawnSync(["bun", path.join(root, "src", "cli.ts"), ...args, "--config", config()], {
      cwd: dir,
      env: { ...process.env, AWS_REGION: "eu-west-1" },
    });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-cli-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("plan before generate points at generate", () => {
    const res = run("plan");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/run `cloudgear generate <entry\.ts>` first/);
  });

  test("generate, plan, import, plan", () => {
    const generated = run(
      "generate",
      entry,
      "--project",
      "demo",
      "--invoker",
      "arn:aws:iam::123456789012:role/vercel",
      "--reserved-concurrency",
      "3",
    );
    expect(generated.err).toBe("");
    expect(generated.out).toMatch(/3 function\(s\), 2 resource\(s\)/);
    expect(fs.existsSync(path.join(dir, ".cloudgear/build/foo/index.mjs"))).toBe(true);

    const text = fs.readFileSync(config(), "utf8");
    expect(text).toContain('invoker: "arn:aws:iam::123456789012:role/vercel"');
    expect(text.match(/reserved_concurrency: 3/g)).toHaveLength(3);

    const first = run("plan");
    expect(first.out).toContain("= @aws.S3 myblob (dry");
    expect(first.out).toContain("+ @aws.S3 cloudgear-example-archive");
    expect(first.out).toContain("Plan: 4 to create");

    const imported = run("import", "cloudgear-example-archive", "existing-archive");
    expect(imported.out).toContain('as "existing-archive"');

    const second = run("plan");
    expect(second.out).toContain("Plan: 3 to create");
    expect(second.out).not.toContain("+ @aws.S3");
  });

  test("generate rejects a malformed invoker", () => {
    const res = run("generate", entry, "--invoker", "not-an-arn");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/Invalid invoker "not-an-arn"/);
  });

  test("import refuses to replace a resource cloudgear manages", () => {
    const statePath = path.join(dir, ".cloudgear/state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.entries["@aws.S3.cloudgear-example-archive"].imported = false;
    fs.writeFileSync(statePath, JSON.stringify(state));

    const res = run("import", "cloudgear-example-archive", "other");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/already managed by cloudgear/);
  });

  test("import rejects names that are not in the config", () => {
    const res = run("import", "nothing-like-this");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/Nothing named "nothing-like-this" is in .*run `cloudgear plan` to see the names/);
  });

  test("unknown commands fail with usage", () => {
    const res = run("frobnicate");
    expect(res.code).toBe(1);
    expect(res.err).toContain('Unknown command "frobnicate"');
  });
});

describe("cloudgear CLI with a CDN", () => {
  let dir: string;
  const cdnEntry = path.join(root, "tests", "fixtures", "router", "edge", "app.ts");
  const config = () => path.join(dir, "cloudgear.prototxt");
  const run = (...args: string[]) => {
    const proc = Bun.spawnSync(["bun", path.join(root, "src", "cli.ts"), ...args, "--config", config()], {
      cwd: dir,
      env: { ...process.env, AWS_REGION: "eu-west-1" },
    });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-cli-cdn-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("plan lists the certificate and CDN after what they depend on", () => {
    expect(run("generate", cdnEntry, "--project", "edge").err).toBe("");
    const plan = run("plan").out;
    const at = (entry: string) => plan.indexOf(`+ ${entry}`);
    const order = ["@aws.Lambda getObject", "@aws.Certificate api.example.com", "@aws.ApiGateway api.example.com", "@aws.Certificate www.example.com", "@aws.CloudFront www.example.com"].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order[2]).toBeGreaterThan(order[0]!);
    expect(order[2]).toBeGreaterThan(order[1]!);
    expect(order[4]).toBeGreaterThan(order[3]!);
    expect(plan).toContain("Plan: 8 to create");
  });

  test("invalidate before anything is deployed explains what to do", () => {
    const res = run("invalidate");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/No CDN has been deployed; run `cloudgear apply` first/);
  });

  test("import needs a name or --all, and says when a name is ambiguous or unknown", () => {
    expect(run("import").err).toMatch(/Usage: cloudgear import/);
    const unknown = run("import", "nothing-like-this");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/Nothing named "nothing-like-this"/);
    const ambiguous = run("import", "www.example.com");
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toMatch(/names several things \(@aws\.Certificate, @aws\.CloudFront\); say which: cloudgear import <type> www\.example\.com/);
    expect(run("import", "@aws.Certificate", "www.example.com", "an-id").err).toMatch(/physical id can only be given for a bucket/);
    expect(run("import", "@aws.Certificate").err).toMatch(/Usage: cloudgear import @aws\.Certificate <name>/);
    expect(run("import", "--all", "www.example.com").err).toMatch(/import --all takes no name/);
  });

  test("--write-policies is for functions: a bucket and an empty value are refused", () => {
    const stateFile = path.join(dir, ".cloudgear", "state.json");
    fs.rmSync(stateFile, { force: true });
    expect(run("import", "my-site", "--write-policies", path.join(dir, "policies")).err).toMatch(/a bucket has none/);
    expect(run("import", "my-site", "--write-policies", "").err).toMatch(/--write-policies needs a directory/);
    expect(fs.existsSync(path.join(dir, "policies"))).toBe(false);
    fs.rmSync(stateFile, { force: true });
  });

  test("a bucket can be imported by ARN, and --arn needs one thing", () => {
    const stateFile = path.join(dir, ".cloudgear", "state.json");
    fs.rmSync(stateFile, { force: true });
    expect(run("import", "my-site", "arn:aws:s3:::existing-bucket/some/key").out).toMatch(/imported @aws\.S3 my-site as "existing-bucket"/);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).entries["@aws.S3.my-site"]).toMatchObject({ physical_name: "existing-bucket", imported: true });
    expect(run("import", "my-site", "--arn", "arn:aws:s3:::second").out).toMatch(/as "second"/);
    expect(run("import", "my-site", "arn:aws:acm:us-east-1:1:certificate/x").err).toMatch(/is not an S3 bucket ARN/);
    expect(run("import", "--all", "--arn", "arn:aws:s3:::x").err).toMatch(/--arn names one thing/);
    expect(run("import", "my-site", "existing", "--arn", "arn:aws:s3:::other").err).toMatch(/not both/);
    expect(run("import", "my-site", "--arn", "just-a-name").err).toMatch(/is not an ARN/);
    expect(run("import", "my-site", "arn:aws-cn:s3:::cn-bucket").out).toMatch(/as "cn-bucket"/);
    expect(run("import", "my-site", "arn:aws:s3:us-east-1:111122223333:accesspoint/ap").err).toMatch(/access point's ARN does not name the bucket/);
    expect(run("import", "www.example.com", "--arn", "arn:aws:s3:::x").err).toMatch(/Nothing named "www\.example\.com" of type @aws\.S3/);
    expect(run("import", "@aws.Certificate", "www.example.com", "--arn", "arn:aws:s3:::x").err).toMatch(/is a @aws\.S3 ARN, not a @aws\.Certificate one/);
    expect(run("import", "--arn", "arn:aws:sqs:us-east-1:111122223333:queue").err).toMatch(/Importing a sqs ARN is not supported/);
    expect(run("import", "--arn", "arn:aws:s3:::no-such-bucket").err).toMatch(/No bucket named "no-such-bucket"/);
    expect(run("import", "--arn", "arn:aws:s3:::my-site/some/key").err).toMatch(/names an object, not a bucket/);
    expect(run("import", "--arn", "arn:aws:s3:::my-site").out).toMatch(/imported @aws\.S3 my-site as "my-site"/);
    fs.rmSync(stateFile, { force: true });
  });

  test("invalidate rejects paths without a leading slash", () => {
    const stateDir = path.join(dir, ".cloudgear");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({
        version: 1,
        project: "edge",
        provider: "aws",
        entries: { "@aws.CloudFront.www.example.com": { kind: "resource", type: "@aws.CloudFront", name: "www.example.com", physical_name: "www.example.com", spec: { bucket: "my-site" }, outputs: { id: "E1" } } },
      }),
    );
    const res = run("invalidate", "index.html");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/Invalidation path "index.html" must start with "\/"/);
  });
});

describe("choosing the CDN to invalidate", () => {
  const entry = (name: string, bucket: string, id = "E") => ({ kind: "resource" as const, type: "@aws.CloudFront", name, physical_name: name, spec: { bucket }, outputs: { id } });
  const config = (cdn: string[], api?: string) => ({ project: "p", provider: "aws", resource: [], function: [], invoker: [], authenticated: "iam" as const, certificate: [], cdn: cdn.map((domain) => ({ provider: "aws", domain, bucket: "b", path: "" })), ...(api ? { api: { provider: "aws", domain: api, via: "cloudfront" as const } } : {}) });
  const state = (...entries: ReturnType<typeof entry>[]) => ({ version: 1 as const, project: "p", provider: "aws", entries: Object.fromEntries(entries.map((e) => [`@aws.CloudFront.${e.name}`, e])) });

  test("one site and the router's distribution needs no --domain", async () => {
    const { siteDistributions, pickDistribution } = await import("../src/cdnselect");
    const sites = siteDistributions(config(["www.example.com"], "api.example.com"), state(entry("www.example.com", "web", "E1"), entry("api.example.com", "", "E2")));
    expect(pickDistribution(sites, undefined).outputs.id).toBe("E1");
  });

  test("the router's distribution cannot be picked, with or without being the api domain in the config", async () => {
    const { siteDistributions, pickDistribution } = await import("../src/cdnselect");
    const stale = siteDistributions(config(["www.example.com"]), state(entry("www.example.com", "web", "E1"), entry("old-api.example.com", "", "E2")));
    expect(stale.map((e) => e.name)).toEqual(["www.example.com"]);
    expect(() => pickDistribution(stale, "old-api.example.com")).toThrow(/router's distribution cannot be invalidated/);
  });

  test("a site removed from the config is not offered, and --domain picks one of several", async () => {
    const { siteDistributions, pickDistribution } = await import("../src/cdnselect");
    const sites = siteDistributions(config(["a.example.com", "b.example.com"]), state(entry("a.example.com", "x", "EA"), entry("b.example.com", "y", "EB"), entry("gone.example.com", "z", "EG")));
    expect(sites.map((e) => e.name).sort()).toEqual(["a.example.com", "b.example.com"]);
    expect(pickDistribution(sites, "b.example.com").outputs.id).toBe("EB");
    expect(() => pickDistribution(sites, undefined)).toThrow(/Several CDNs are deployed/);
    expect(() => pickDistribution([], undefined)).toThrow(/No CDN has been deployed/);
  });
});
