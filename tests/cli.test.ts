import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Analyzing an app and bundling functions take seconds when the machine is busy.
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

  test("import rejects unknown names and functions", () => {
    const res = run("import", "foo");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/No resource named "foo".*functions cannot be imported/);
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
