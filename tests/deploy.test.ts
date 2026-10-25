import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CloudgearConfig, FunctionSpec } from "../src/config/schema";
import { apply, endpointsFrom } from "../src/deploy/apply";
import { awsDrivers, policyDocument, type SendClient } from "../src/deploy/aws";
import { formatPlan, plan, type FunctionComparable } from "../src/deploy/plan";
import type { State } from "../src/deploy/state";
import { zip } from "../src/build/zip";
import { fitName, sanitizeName } from "../src/names";

const fn = (overrides: Partial<FunctionSpec> = {}): FunctionSpec => ({
  name: "foo",
  type: "@aws.Lambda",
  physical_name: "app-foo",
  runtime: "nodejs22.x",
  memory_mb: 256,
  timeout_s: 10,
  source: { file: "server/api.ts", export: "foo" },
  route: [{ method: "POST", path: "/foo/{param}" }],
  bundle: { path: "build/foo/index.mjs", sha256: "v1" },
  permission: [{ resource: "data", action: ["s3:PutObject", "s3:ListBucket"] }],
  env: [{ key: "CLOUDGEAR_BLOB_DATA", value_from: "data" }],
  ...overrides,
});

const baseConfig = (overrides: Partial<CloudgearConfig> = {}): CloudgearConfig => ({
  project: "app",
  provider: "aws",
  resource: [
    { name: "data", type: "@aws.S3", physical_name: "data", dry: false, source: "a.ts:1" },
    { name: "legacy", type: "@aws.S3", physical_name: "legacy", dry: true, source: "a.ts:2" },
  ],
  function: [fn()],
  ...overrides,
});

const emptyState = (): State => ({ version: 1, project: "app", provider: "aws", entries: {} });

// Records every SDK command and answers with canned responses.
function fakeAws(overrides: Record<string, (input: any, attempt: number) => any> = {}) {
  const calls: { name: string; input: any }[] = [];
  const counts = new Map<string, number>();
  const defaults: Record<string, (input: any) => any> = {
    CreateRoleCommand: (input) => ({ Role: { Arn: `arn:aws:iam::1:role/${input.RoleName}` } }),
    CreateFunctionCommand: (input) => ({ FunctionArn: `arn:aws:lambda:x:1:function:${input.FunctionName}` }),
    GetFunctionConfigurationCommand: () => ({ State: "Active", LastUpdateStatus: "Successful" }),
    CreateFunctionUrlConfigCommand: (input) => ({ FunctionUrl: `https://${input.FunctionName}.lambda-url.test/` }),
  };
  const client: SendClient = {
    async send(command) {
      const name = command.constructor.name as string;
      const attempt = counts.get(name) ?? 0;
      counts.set(name, attempt + 1);
      calls.push({ name, input: command.input });
      const respond = overrides[name] ?? defaults[name];
      return respond ? respond(command.input, attempt) : {};
    },
  };
  const drivers = awsDrivers({
    region: "eu-west-1",
    readBundle: () => new TextEncoder().encode("export const handler = () => {};"),
    clients: { s3: client, lambda: client, iam: client },
    sleep: async () => {},
  });
  return { calls, drivers, names: () => calls.map((c) => c.name) };
}

async function applyAll(config: CloudgearConfig, state: State, aws = fakeAws()) {
  await apply(plan(config, state), state, aws.drivers, { save: () => {} });
  return aws;
}

describe("plan", () => {
  test("creates everything but dry resources on an empty state", () => {
    const actions = plan(baseConfig(), emptyState());
    expect(actions.map((a) => [a.op, a.key])).toEqual([
      ["create", "@aws.S3.data"],
      ["dry", "@aws.S3.legacy"],
      ["create", "@aws.Lambda.foo"],
    ]);
    expect(formatPlan(actions)).toContain("Plan: 2 to create, 0 to update, 0 to replace, 0 to delete, 0 to forget.");
  });

  test("is a no-op once applied, and classifies function changes", async () => {
    const state = emptyState();
    await applyAll(baseConfig(), state);
    expect(plan(baseConfig(), state).map((a) => a.op)).toEqual(["noop", "dry", "noop"]);

    const changed = baseConfig({
      function: [fn({ bundle: { path: "x", sha256: "v2" }, memory_mb: 512, permission: [] })],
    });
    expect(plan(changed, state).find((a) => a.kind === "function")).toMatchObject({
      op: "update",
      changes: ["code", "config", "permissions"],
    });
    expect(plan(baseConfig({ function: [fn({ physical_name: "renamed" })] }), state)[2]).toMatchObject({ op: "replace" });
  });

  test("deletes removed entries, functions before resources, and only forgets imported ones", async () => {
    const state = emptyState();
    await applyAll(baseConfig(), state);
    state.entries["@aws.S3.adopted"] = {
      kind: "resource",
      type: "@aws.S3",
      name: "adopted",
      physical_name: "adopted",
      imported: true,
      spec: {},
      outputs: {},
    };
    const actions = plan(baseConfig({ resource: [], function: [] }), state);
    expect(actions.map((a) => [a.op, a.key])).toEqual([
      ["delete", "@aws.Lambda.foo"],
      ["delete", "@aws.S3.data"],
      ["forget", "@aws.S3.adopted"],
    ]);
  });

  test("an imported resource is never created and lends functions its physical name", () => {
    const state = emptyState();
    state.entries["@aws.S3.data"] = {
      kind: "resource",
      type: "@aws.S3",
      name: "data",
      physical_name: "existing-bucket",
      imported: true,
      spec: { physical_name: "existing-bucket" },
      outputs: {},
    };
    const actions = plan(baseConfig(), state);
    expect(actions[0]).toMatchObject({ op: "noop", key: "@aws.S3.data" });
    const spec = actions[2]!.desired!.spec as unknown as FunctionComparable;
    expect(spec.env).toEqual({ CLOUDGEAR_BLOB_DATA: "existing-bucket" });
    expect(spec.permissions).toEqual([{ type: "@aws.S3", physical_name: "existing-bucket", actions: ["s3:ListBucket", "s3:PutObject"] }]);
  });
});

describe("aws drivers", () => {
  test("apply creates the bucket, then role, policy, function and public URL", async () => {
    const state = emptyState();
    const aws = await applyAll(baseConfig(), state);

    expect(aws.names()).toEqual([
      "CreateBucketCommand",
      "CreateRoleCommand",
      "AttachRolePolicyCommand",
      "PutRolePolicyCommand",
      "CreateFunctionCommand",
      "GetFunctionConfigurationCommand",
      "CreateFunctionUrlConfigCommand",
      "AddPermissionCommand",
      "AddPermissionCommand",
    ]);
    expect(aws.calls[0]!.input).toEqual({ Bucket: "data", CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } });
    expect(JSON.parse(aws.calls[3]!.input.PolicyDocument)).toEqual({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: ["s3:PutObject"], Resource: "arn:aws:s3:::data/*" },
        { Effect: "Allow", Action: ["s3:ListBucket"], Resource: "arn:aws:s3:::data" },
      ],
    });
    expect(aws.calls[4]!.input).toMatchObject({
      FunctionName: "app-foo",
      Handler: "index.handler",
      Runtime: "nodejs22.x",
      Role: "arn:aws:iam::1:role/app-foo-role",
      Environment: { Variables: { CLOUDGEAR_BLOB_DATA: "data" } },
    });
    expect(state.entries["@aws.Lambda.foo"]!.outputs).toMatchObject({
      url: "https://app-foo.lambda-url.test/",
      role_name: "app-foo-role",
    });
    expect(endpointsFrom(baseConfig(), state)).toEqual({
      provider: "aws",
      routes: { "POST /foo/{param}": "https://app-foo.lambda-url.test/" },
    });
  });

  test("retries CreateFunction while the new role propagates", async () => {
    const aws = fakeAws({
      CreateFunctionCommand: (input, attempt) => {
        if (attempt < 2) throw new Error("The role defined for the function cannot be assumed by Lambda.");
        return { FunctionArn: `arn:${input.FunctionName}` };
      },
    });
    await applyAll(baseConfig(), emptyState(), aws);
    expect(aws.names().filter((n) => n === "CreateFunctionCommand")).toHaveLength(3);
  });

  test("updates only what changed and drops the inline policy when no permissions remain", async () => {
    const state = emptyState();
    await applyAll(baseConfig(), state);
    const aws = await applyAll(
      baseConfig({ function: [fn({ bundle: { path: "x", sha256: "v2" }, permission: [] })] }),
      state,
    );
    expect(aws.names()).toEqual(["DeleteRolePolicyCommand", "UpdateFunctionCodeCommand", "GetFunctionConfigurationCommand"]);
  });

  test("destroy tears down the function and its role, tolerating already-deleted pieces", async () => {
    const state = emptyState();
    await applyAll(baseConfig(), state);
    const notFound = (name: string) => () => {
      throw Object.assign(new Error("gone"), { name });
    };
    const aws = await applyAll(
      baseConfig({ resource: [], function: [] }),
      state,
      fakeAws({ DeleteFunctionCommand: notFound("ResourceNotFoundException") }),
    );
    expect(aws.names()).toEqual([
      "DeleteFunctionCommand",
      "DeleteRolePolicyCommand",
      "DetachRolePolicyCommand",
      "DeleteRoleCommand",
      "DeleteBucketCommand",
    ]);
    expect(state.entries).toEqual({});
  });

  test("a failure part-way keeps the state of what already succeeded", async () => {
    const state = emptyState();
    const aws = fakeAws({
      CreateRoleCommand: () => {
        throw new Error("AccessDenied");
      },
    });
    await expect(apply(plan(baseConfig(), state), state, aws.drivers, { save: () => {} })).rejects.toThrow("AccessDenied");
    expect(Object.keys(state.entries)).toEqual(["@aws.S3.data"]);
  });

  test("policyDocument refuses resource types it has no mapping for", () => {
    expect(() =>
      policyDocument({ permissions: [{ type: "@gcp.Storage", physical_name: "x", actions: [] }] } as unknown as FunctionComparable),
    ).toThrow(/No IAM mapping/);
  });
});

describe("invoke token", () => {
  test("is part of every function's env and of the endpoints file", async () => {
    const state = emptyState();
    state.invoke_token = "tok";
    const spec = plan(baseConfig(), state).find((a) => a.kind === "function")!.desired!.spec as unknown as FunctionComparable;
    expect(spec.env).toMatchObject({ CLOUDGEAR_INVOKE_TOKEN: "tok", CLOUDGEAR_BLOB_DATA: "data" });

    const aws = await applyAll(baseConfig(), state);
    const create = aws.calls.find((c) => c.name === "CreateFunctionCommand")!;
    expect(create.input.Environment.Variables.CLOUDGEAR_INVOKE_TOKEN).toBe("tok");
    expect(endpointsFrom(baseConfig(), state).token).toBe("tok");
  });

  test("rotating it is a config update", async () => {
    const state = emptyState();
    state.invoke_token = "one";
    await applyAll(baseConfig(), state);
    state.invoke_token = "two";
    expect(plan(baseConfig(), state).find((a) => a.kind === "function")).toMatchObject({ op: "update", changes: ["config"] });
  });
});

describe("failure handling", () => {
  test("a mid-create failure rolls back what that call created", async () => {
    const state = emptyState();
    const aws = fakeAws({
      CreateFunctionUrlConfigCommand: () => {
        throw new Error("boom");
      },
    });
    await expect(apply(plan(baseConfig(), state), state, aws.drivers, { save: () => {} })).rejects.toThrow("boom");
    expect(aws.names().slice(-4)).toEqual([
      "DeleteFunctionCommand",
      "DeleteRolePolicyCommand",
      "DetachRolePolicyCommand",
      "DeleteRoleCommand",
    ]);
    expect(Object.keys(state.entries)).toEqual(["@aws.S3.data"]);
  });

  test("a role that already exists is left alone", async () => {
    const aws = fakeAws({
      CreateRoleCommand: () => {
        throw Object.assign(new Error("exists"), { name: "EntityAlreadyExists" });
      },
    });
    await expect(applyAll(baseConfig(), emptyState(), aws)).rejects.toThrow("exists");
    expect(aws.names()).not.toContain("DeleteRoleCommand");
  });

  test("deleting a non-empty bucket explains what to do", async () => {
    const state = emptyState();
    await applyAll(baseConfig(), state);
    const aws = fakeAws({
      DeleteBucketCommand: () => {
        throw Object.assign(new Error("x"), { name: "BucketNotEmpty" });
      },
    });
    await expect(applyAll(baseConfig({ resource: [], function: [] }), state, aws)).rejects.toThrow(
      /Bucket "data" is not empty; empty it/,
    );
    expect(state.entries["@aws.Lambda.foo"]).toBeUndefined();
    expect(state.entries["@aws.S3.data"]).toBeDefined();
  });
});

describe("names", () => {
  test("sanitizeName keeps Lambda-safe characters", () => {
    expect(sanitizeName("[id].tsx")).toBe("id-tsx");
    expect(sanitizeName("get_item-2")).toBe("get_item-2");
    expect(sanitizeName("!!!")).toBe("fn");
  });

  test("fitName leaves short names and keeps long names distinct", () => {
    expect(fitName("short", 64)).toBe("short");
    const prefix = "p".repeat(70);
    const a = fitName(`${prefix}-one`, 64);
    const b = fitName(`${prefix}-two`, 64);
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
  });

  test("two functions sharing a long prefix get different IAM roles", async () => {
    const prefix = "p".repeat(70);
    const config = baseConfig({
      function: [fn({ name: "a", physical_name: `${prefix}-a` }), fn({ name: "b", physical_name: `${prefix}-b` })],
    });
    const aws = await applyAll(config, emptyState());
    const roles = aws.calls.filter((c) => c.name === "CreateRoleCommand").map((c) => c.input.RoleName);
    expect(new Set(roles).size).toBe(2);
    expect(roles.every((r) => r.length <= 64)).toBe(true);
  });
});

describe("zip", () => {
  test("produces an archive that a standard unzip tool reads back", () => {
    const archive = zip([{ name: "index.mjs", data: new TextEncoder().encode("export const x = 1;\n".repeat(50)) }]);
    const tmp = path.join(os.tmpdir(), `cloudgear-zip-${process.pid}.zip`);
    fs.writeFileSync(tmp, archive);
    try {
      const proc = Bun.spawnSync([
        "python3",
        "-I",
        "-c",
        "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; sys.stdout.write(z.read('index.mjs').decode())",
        tmp,
      ]);
      expect(proc.stderr.toString()).toBe("");
      expect(proc.stdout.toString()).toBe("export const x = 1;\n".repeat(50));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
