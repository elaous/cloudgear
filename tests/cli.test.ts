import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    const generated = run("generate", entry, "--project", "demo");
    expect(generated.err).toBe("");
    expect(generated.out).toMatch(/3 function\(s\), 2 resource\(s\)/);
    expect(fs.existsSync(path.join(dir, ".cloudgear/build/foo/index.mjs"))).toBe(true);

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
