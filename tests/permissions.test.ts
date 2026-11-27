import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeConfig } from "../src/config/schema";
import { plan } from "../src/deploy/plan";
import { formatPermissions, intentsOf } from "../src/permissions";
import { providerProfile } from "../src/providers";
import { applyAll, baseConfig, emptyState, fn } from "./helpers";

const root = path.join(import.meta.dir, "..");
const read = { resource: "data", path: "", action: ["s3:GetObject", "s3:ListBucket"] };
const write = { resource: "data", path: "", action: ["s3:PutObject"] };

const configWith = (...permission: (typeof read)[]) => baseConfig({ function: [fn({ permission })] });

describe("intentsOf", () => {
  test("names the intents whose provider actions are all granted", () => {
    expect(intentsOf("@aws.S3", ["s3:GetObject", "s3:ListBucket"])).toEqual(["read", "list"]);
    expect(intentsOf("@aws.S3", ["s3:ListBucket"])).toEqual(["list"]);
    expect(intentsOf("@aws.S3", ["s3:PutObject", "s3:DeleteObject"])).toEqual(["write", "delete"]);
    expect(intentsOf("@gcp.GCS", ["storage.objects.get", "storage.objects.list"])).toEqual(["read", "list"]);
    expect(intentsOf("@aws.S3", ["s3:GetBucketPolicy"])).toEqual([]);
  });

  test("a store of another provider's type has no intents", () => {
    expect(intentsOf("@aws.Kinesis", ["s3:GetObject"])).toEqual([]);
  });
});

describe("the README table of intents", () => {
  test("lists the actions each provider maps an intent to", () => {
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const rows = readme.split("\n").filter((line) => /^\| `(read|write|delete|list)` \|/.test(line));
    expect(rows).toHaveLength(4);
    const cells = (line: string) => line.split("|").slice(1, -1).map((cell) => cell.trim());
    const actionsIn = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const row of rows) {
      const [intent, aws, gcp] = cells(row);
      const name = intent!.replaceAll("`", "") as "read" | "write" | "delete" | "list";
      expect(actionsIn(aws!)).toEqual(providerProfile("aws").blobStore.actions[name]);
      expect(actionsIn(gcp!)).toEqual(providerProfile("gcp").blobStore.actions[name]);
    }
  });
});

describe("formatPermissions", () => {
  test("a new function lists what it is granted", () => {
    const text = formatPermissions(plan(configWith(read), emptyState()));
    expect(text).toBe(
      ["Permissions (+ granted, - revoked):", "  + @aws.Lambda foo", '    + @aws.S3 data: s3:GetObject, s3:ListBucket  [read, list]'].join("\n"),
    );
  });

  test("the paths of a bucket are separate lines", () => {
    const text = formatPermissions(plan(configWith({ ...read, path: "img/" }, { ...write, path: "up/" }), emptyState()));
    expect(text).toContain('+ @aws.S3 data under "img/": s3:GetObject, s3:ListBucket');
    expect(text).toContain('+ @aws.S3 data under "up/": s3:PutObject  [write]');
  });

  test("an unchanged function shows its permissions without a change mark", async () => {
    const state = emptyState();
    await applyAll(configWith(read), state);
    const text = formatPermissions(plan(configWith(read), state));
    expect(text).toContain("\n    @aws.Lambda foo\n");
    expect(text).toContain("      @aws.S3 data: s3:GetObject, s3:ListBucket");
    expect(text).not.toMatch(/ [+~-] @aws\.S3/);
  });

  test("a wider grant is a change that names the actions", async () => {
    const state = emptyState();
    await applyAll(configWith(read), state);
    const text = formatPermissions(plan(configWith({ ...read, action: [...read.action, "s3:PutObject"] }), state));
    expect(text).toContain("  ~ @aws.Lambda foo");
    expect(text).toContain("    ~ @aws.S3 data: s3:GetObject, s3:ListBucket, s3:PutObject  [read, write, list] (+s3:PutObject)");
  });

  test("a narrower grant names what was revoked, and a removed bucket is a revoked line", async () => {
    const state = emptyState();
    await applyAll(configWith({ ...read, action: [...read.action, "s3:PutObject"] }, { ...write, path: "up/" }), state);
    const text = formatPermissions(plan(configWith(read), state));
    expect(text).toContain("(-s3:PutObject)");
    expect(text).toContain('    - @aws.S3 data under "up/": s3:PutObject');
  });

  test("a removed function loses everything", async () => {
    const state = emptyState();
    await applyAll(configWith(read), state);
    const text = formatPermissions(plan(baseConfig({ function: [] }), state));
    expect(text).toContain("  - @aws.Lambda foo");
    expect(text).toContain("    - @aws.S3 data: s3:GetObject, s3:ListBucket");
  });

  test("a function with no access says so", () => {
    const text = formatPermissions(plan(baseConfig({ function: [fn({ permission: [] })] }), emptyState()));
    expect(text).toContain("      no permissions");
  });

  test("secrets and declared policies are listed too", () => {
    const secret = { provider: "aws", service: "ssm", path: "/app", name: "STRIPE_KEY", env: "STRIPE_KEY" };
    const all = { provider: "aws", service: "ssm", path: "/shared", name: "", env: "", all: true };
    const config = baseConfig({ function: [fn({ permission: [], secret: [secret, all], policy: [{ name: "readBucket", document: "{}" }] } as never)] });
    const text = formatPermissions(plan(config, emptyState()));
    expect(text).toContain("+ secret ssm /app/STRIPE_KEY as STRIPE_KEY");
    expect(text).toContain("+ secret ssm /shared/*");
    expect(text).toContain("+ policy readBucket");
  });

  test("nothing is printed when no function is planned", () => {
    expect(formatPermissions(plan(baseConfig({ function: [] }), emptyState()))).toBe("");
  });
});

describe("plan --permissions", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const cli = (...args: string[]) => {
    const config = path.join(dir, "cloudgear.prototxt");
    fs.writeFileSync(config, encodeConfig(configWith({ ...read, path: "img/" })));
    const proc = Bun.spawnSync(["bun", path.join(root, "src", "cli.ts"), "plan", "--config", config, ...args], { cwd: dir, env: { ...process.env, AWS_REGION: "eu-west-1" } });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  };

  test("prints the permissions after the plan, only when asked", () => {
    const without = cli();
    expect(without.code).toBe(0);
    expect(without.out).not.toContain("Permissions (");
    const withFlag = cli("--permissions");
    expect(withFlag.code).toBe(0);
    expect(withFlag.out).toContain("Plan: ");
    expect(withFlag.out.indexOf("Permissions (")).toBeGreaterThan(withFlag.out.indexOf("Plan: "));
    expect(withFlag.out).toContain('+ @aws.S3 data under "img/": s3:GetObject, s3:ListBucket  [read, list]');
  });
});
