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
    const order = ["@aws.Lambda getObject", "@aws.Certificate cdn.example.com", "@aws.CloudFront cdn.example.com"].map((entry) => plan.indexOf(`+ ${entry}`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order[2]).toBeGreaterThan(order[0]!);
    expect(order[2]).toBeGreaterThan(order[1]!);
    expect(plan).toContain("Plan: 6 to create");
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
        entries: { "@aws.CloudFront.cdn.example.com": { kind: "resource", type: "@aws.CloudFront", name: "cdn.example.com", physical_name: "cdn.example.com", spec: {}, outputs: { id: "E1" } } },
      }),
    );
    const res = run("invalidate", "index.html");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/Invalidation path "index.html" must start with "\/"/);
  });
});
