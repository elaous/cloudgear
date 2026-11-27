import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeConfig } from "../src/config/schema";
import { plan, type PlannedAction } from "../src/deploy/plan";
import { stateKey } from "../src/deploy/state";
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

  test("a GCS function lists the roles it is granted on the bucket", () => {
    const config = baseConfig({
      provider: "gcp",
      resource: [{ name: "data", type: "@gcp.GCS", physical_name: "data", dry: false, source: "a.ts:1" }],
      function: [fn({ type: "@gcp.CloudFunction", permission: [{ resource: "data", path: "img/", action: ["storage.objects.get", "storage.objects.list", "storage.objects.delete"] }] })],
    });
    const text = formatPermissions(plan(config, emptyState()));
    expect(text).toContain('+ @gcp.GCS data under "img/": storage.objects.delete, storage.objects.get, storage.objects.list  [read, delete, list]');
    expect(text).toContain('+ roles/storage.objectUser on bucket data under "img/"');
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

describe("what state and the plan say about the function", () => {
  const applied = async (config = configWith(read)) => {
    const state = emptyState();
    await applyAll(config, state);
    return state;
  };
  const key = stateKey({ type: "@aws.Lambda", name: "foo" });

  test("a half-applied function is compared with the spec before it", async () => {
    const state = await applied();
    const entry = state.entries[key]!;
    const attempted = configWith(read, { ...write, path: "up/" });
    const desired = plan(attempted, state).find((a) => a.kind === "function")!.desired!.spec;
    entry.spec = { ...desired, incomplete: true, previous: entry.spec };
    const text = formatPermissions(plan(attempted, state));
    expect(text).toContain("  ~ @aws.Lambda foo");
    expect(text).toContain('    + @aws.S3 data under "up/": s3:PutObject  [write]');
    expect(text).toMatch(/\n {6}@aws\.S3 data: s3:GetObject/);
  });

  test("a function whose first apply failed has nothing to compare with", async () => {
    const state = await applied();
    const entry = state.entries[key]!;
    entry.spec = { ...entry.spec, incomplete: true };
    delete (entry.spec as { previous?: unknown }).previous;
    expect(formatPermissions(plan(configWith(read), state))).toContain("    + @aws.S3 data: s3:GetObject, s3:ListBucket");
  });

  test("an imported function that leaves the config is forgotten, not revoked", async () => {
    const state = await applied();
    state.entries[key]!.imported = true;
    const text = formatPermissions(plan(baseConfig({ function: [] }), state));
    expect(text).toContain("  ~ @aws.Lambda foo");
    expect(text).toContain("imported: removed from state only, nothing is revoked");
    expect(text).not.toContain("    - @aws.S3");
  });

  test("an imported function's access is not managed", async () => {
    const state = await applied();
    state.entries[key]!.imported = true;
    const text = formatPermissions(plan(configWith(write), state));
    expect(text).toContain("imported: its access is not managed by cloudgear");
    expect(text).not.toContain("s3:PutObject");
  });

  test("a replaced function loses the old grants and gets the new ones", async () => {
    const state = await applied();
    const config = baseConfig({ function: [fn({ physical_name: "app-foo-2", permission: [read] })] });
    const planned = plan(config, state);
    expect(planned.find((a) => a.kind === "function")!.op).toBe("replace");
    const text = formatPermissions(planned);
    expect(text).toContain("  -/+ @aws.Lambda foo");
    expect(text).toContain("    - @aws.S3 data: s3:GetObject, s3:ListBucket");
    expect(text).toContain("    + @aws.S3 data: s3:GetObject, s3:ListBucket");
  });

  test("tracing is access too", () => {
    const config = baseConfig({ function: [fn({ permission: [], options: { tracing: "Active" } })] });
    const text = formatPermissions(plan(config, emptyState()));
    expect(text).toContain("+ tracing: xray:PutTraceSegments, xray:PutTelemetryRecords on *");
    expect(text).not.toContain("no permissions");
  });

  test("a secret shows its region, its KMS key and the list permission of Secrets Manager", () => {
    const base = { provider: "aws", service: "ssm", path: "/a", name: "K", env: "K" };
    const config = baseConfig({
      function: [
        fn({
          permission: [],
          secret: [
            { ...base, region: "eu-west-1", kms_key: "alias/app" },
            { ...base, region: "us-east-1", name: "K" },
            { provider: "aws", service: "secretsmanager", path: "/sm", name: "", env: "", all: true },
          ],
        } as never),
      ],
    });
    const text = formatPermissions(plan(config, emptyState()));
    expect(text).toContain("+ secret ssm in eu-west-1 /a/K as K");
    expect(text).toContain("+ secret ssm in us-east-1 /a/K as K");
    expect(text).toContain("+ secret secretsmanager /sm/* (and secretsmanager:ListSecrets)");
    expect(text).toContain("+ kms:Decrypt with alias/app");
  });

  test("renaming the environment variable of a secret is one changed line", async () => {
    const secret = { provider: "aws", service: "ssm", path: "/a", name: "K", env: "OLD" };
    const state = await applied(baseConfig({ function: [fn({ permission: [], secret: [secret] } as never)] }));
    const text = formatPermissions(plan(baseConfig({ function: [fn({ permission: [], secret: [{ ...secret, env: "NEW" }] } as never)] }), state));
    expect(text).toContain("~ secret ssm /a/K as NEW (OLD -> NEW)");
    expect(text).not.toContain("- secret");
  });

  test("entries for the same store and path are granted together", () => {
    const text = formatPermissions(plan(configWith({ ...write, action: ["s3:PutObject", "s3:PutObject"] }, { ...read }), emptyState()));
    expect(text).toContain("+ @aws.S3 data: s3:GetObject, s3:ListBucket, s3:PutObject");
    const twice = formatPermissions(plan(configWith({ ...write }, { ...read, action: ["s3:GetObject"] }), emptyState()));
    expect(twice.match(/@aws\.S3 data:/g)).toHaveLength(1);
    expect(twice).toContain("s3:GetObject, s3:PutObject");
  });

  test("declared policies show the actions they allow and when their document changes", async () => {
    const document = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket"], Resource: "*" }, { Effect: "Allow", Action: "sqs:SendMessage", Resource: "*" }] });
    const state = await applied(baseConfig({ function: [fn({ permission: [], policy: [{ name: "readBucket", document }] } as never)] }));
    const same = formatPermissions(plan(baseConfig({ function: [fn({ permission: [], policy: [{ name: "readBucket", document }] } as never)] }), state));
    expect(same).toContain("policy readBucket: s3:GetObject, s3:ListBucket, sqs:SendMessage");
    const changed = formatPermissions(plan(baseConfig({ function: [fn({ permission: [], policy: [{ name: "readBucket", document: JSON.stringify({ Statement: [{ Action: "s3:*", Resource: "*" }] }) }] } as never)] }), state));
    expect(changed).toContain("~ policy readBucket: s3:* (document changed)");
    expect(formatPermissions(plan(baseConfig({ function: [fn({ permission: [], policy: [{ name: "opaque", document: "not json" }] } as never)] }), emptyState()))).toMatch(/\+ policy opaque$/);
  });

  test("a GCS permission no role covers is reported on its function, not by crashing the plan", () => {
    const gcs = (name: string, action: string) =>
      fn({ name, physical_name: `app-${name}`, type: "@gcp.CloudFunction", permission: [{ resource: "data", path: "", action: [action] }] });
    const config = baseConfig({
      provider: "gcp",
      resource: [{ name: "data", type: "@gcp.GCS", physical_name: "data", dry: false, source: "a.ts:1" }],
      function: [gcs("bad", "storage.objects.update"), gcs("good", "storage.objects.get")],
    });
    const text = formatPermissions(plan(config, emptyState()));
    expect(text).toContain("! No GCS role covers storage.objects.update");
    expect(text).toContain("+ roles/storage.objectViewer on bucket data");
  });

  test("the operations of a plan other than functions are ignored", () => {
    const resourceOnly = plan(baseConfig({ function: [] }), emptyState());
    expect(resourceOnly.every((a: PlannedAction) => a.kind === "resource")).toBe(true);
    expect(formatPermissions(resourceOnly)).toBe("");
  });
});

describe("plan --permissions", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(path.join(dir, ".cloudgear"), { recursive: true, force: true }));

  const cli = (...args: string[]) => {
    const config = path.join(dir, "cloudgear.prototxt");
    fs.writeFileSync(config, encodeConfig(configWith({ ...read, path: "img/" })));
    const proc = Bun.spawnSync(["bun", path.join(root, "src", "cli.ts"), "plan", "--config", config, ...args], { cwd: dir, env: { ...process.env, AWS_REGION: "eu-west-1" } });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  };

  test("destroy accepts the flag and lists everything as revoked", async () => {
    const config = path.join(dir, "cloudgear.prototxt");
    fs.writeFileSync(config, encodeConfig(configWith(read)));
    const state = emptyState();
    await applyAll(configWith(read), state);
    fs.mkdirSync(path.join(dir, ".cloudgear"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".cloudgear", "state.json"), JSON.stringify(state));
    const proc = Bun.spawnSync(["bun", path.join(root, "src", "cli.ts"), "destroy", "--config", config, "--permissions"], { cwd: dir, env: { ...process.env, AWS_REGION: "eu-west-1" }, stdin: new TextEncoder().encode("n\n") });
    const out = proc.stdout.toString();
    expect(proc.exitCode).toBe(0);
    expect(out).toContain("  - @aws.Lambda foo");
    expect(out).toContain("    - @aws.S3 data: s3:GetObject, s3:ListBucket");
  });

  test("a plan with no functions prints no permissions section", () => {
    const fresh = fs.mkdtempSync(path.join(dir, "empty-"));
    const config = path.join(fresh, "cloudgear.prototxt");
    fs.writeFileSync(config, encodeConfig(baseConfig({ function: [] })));
    const proc = Bun.spawnSync(["bun", path.join(root, "src", "cli.ts"), "plan", "--config", config, "--permissions"], { cwd: fresh, env: { ...process.env, AWS_REGION: "eu-west-1" } });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).not.toContain("Permissions (");
  });

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
