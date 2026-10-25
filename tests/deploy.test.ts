import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CloudgearConfig, FunctionSpec } from "../src/config/schema";
import { apply, endpointsFrom } from "../src/deploy/apply";
import { awsDrivers, policyDocument, type SendClient } from "../src/deploy/aws";
import { formatPlan, plan, type FunctionComparable } from "../src/deploy/plan";
import { zip } from "../src/build/zip";
import { fitName, sanitizeName } from "../src/names";

import { applyAll, baseConfig, emptyState, fakeAws, fn } from "./helpers";

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
    expect(spec.permissions).toEqual([{ type: "@aws.S3", physical_name: "existing-bucket", path: "", actions: ["s3:ListBucket", "s3:PutObject"] }]);
  });
});

describe("aws drivers", () => {
  test("apply creates the bucket, then role, policy, function and IAM-protected URL", async () => {
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
      url: "https://app-foo.lambda-url.eu-west-1.on.aws/",
      role_name: "app-foo-role",
    });
    expect(endpointsFrom(baseConfig(), state)).toEqual({
      provider: "aws",
      auth: "iam",
      routes: { "POST /foo/{param}": "https://app-foo.lambda-url.eu-west-1.on.aws/" },
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

  test("policyDocument scopes object access and listing to a store's path", () => {
    const doc = JSON.parse(
      policyDocument({
        permissions: [
          { type: "@aws.S3", physical_name: "shared", path: "img-cache/", actions: ["s3:GetObject", "s3:ListBucket"] },
          { type: "@aws.S3", physical_name: "shared", path: "", actions: ["s3:PutObject"] },
        ],
      } as unknown as FunctionComparable),
    );
    expect(doc.Statement).toEqual([
      { Effect: "Allow", Action: ["s3:GetObject"], Resource: "arn:aws:s3:::shared/img-cache/*" },
      {
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: "arn:aws:s3:::shared",
        Condition: { StringLike: { "s3:prefix": ["img-cache/*"] } },
      },
      { Effect: "Allow", Action: ["s3:PutObject"], Resource: "arn:aws:s3:::shared/*" },
    ]);
  });

  test("policyDocument refuses resource types it has no mapping for", () => {
    expect(() =>
      policyDocument({ permissions: [{ type: "@gcp.Storage", physical_name: "x", actions: [] }] } as unknown as FunctionComparable),
    ).toThrow(/No IAM mapping/);
  });
});

describe("bucket regions", () => {
  const withRegion = (region?: string) =>
    baseConfig({ resource: [{ name: "data", type: "@aws.S3", physical_name: "data", dry: false, source: "a.ts:1", region }], function: [] });

  test("a bucket is created in its own region, the deploy region otherwise", async () => {
    const eu = await applyAll(withRegion("eu-central-1"), emptyState());
    expect(eu.of("CreateBucketCommand")).toEqual([{ Bucket: "data", CreateBucketConfiguration: { LocationConstraint: "eu-central-1" } }]);

    const home = await applyAll(withRegion(), emptyState());
    expect(home.of("CreateBucketCommand")).toEqual([{ Bucket: "data", CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } }]);

    const virginia = await applyAll(withRegion("us-east-1"), emptyState());
    expect(virginia.of("CreateBucketCommand")).toEqual([{ Bucket: "data", CreateBucketConfiguration: undefined }]);
  });

  test("a bucket cannot be moved to another region", async () => {
    const state = emptyState();
    await applyAll(withRegion("eu-central-1"), state);
    expect(plan(withRegion("us-east-1"), state).find((a) => a.key === "@aws.S3.data")).toMatchObject({ op: "update" });
    await expect(applyAll(withRegion("us-east-1"), state)).rejects.toThrow(/cannot move from region "eu-central-1" to "us-east-1"/);
  });
});

describe("function URL access", () => {
  const ROLE = "arn:aws:iam::123456789012:role/vercel";

  test("URLs require AWS_IAM and nobody is granted access unless named as an invoker", async () => {
    const aws = await applyAll(baseConfig(), emptyState());
    const url = aws.calls.find((c) => c.name === "CreateFunctionUrlConfigCommand")!;
    expect(url.input.AuthType).toBe("AWS_IAM");
    expect(aws.names()).not.toContain("AddPermissionCommand");
  });

  test("each invoker gets InvokeFunctionUrl and InvokeFunction, scoped to the URL", async () => {
    const aws = await applyAll(baseConfig({ invoker: [ROLE] }), emptyState());
    const grants = aws.calls.filter((c) => c.name === "AddPermissionCommand").map((c) => c.input);
    expect(grants).toMatchObject([
      { Action: "lambda:InvokeFunctionUrl", Principal: ROLE, FunctionUrlAuthType: "AWS_IAM" },
      { Action: "lambda:InvokeFunction", Principal: ROLE, InvokedViaFunctionUrl: true },
    ]);
    expect(new Set(grants.map((g) => g.StatementId)).size).toBe(2);
  });

  test("changing invokers adds and removes only the difference", async () => {
    const other = "123456789012";
    const state = emptyState();
    await applyAll(baseConfig({ invoker: [ROLE] }), state);
    const next = baseConfig({ invoker: [other] });
    expect(plan(next, state).find((a) => a.kind === "function")).toMatchObject({ op: "update", changes: ["invokers"] });

    const aws = await applyAll(next, state);
    expect(aws.names()).toEqual([
      "RemovePermissionCommand",
      "RemovePermissionCommand",
      "AddPermissionCommand",
      "AddPermissionCommand",
    ]);
    expect(aws.calls.filter((c) => c.name === "AddPermissionCommand").every((c) => c.input.Principal === other)).toBe(true);
  });

  test("reserved concurrency is set on create and updated or cleared on change", async () => {
    const state = emptyState();
    const created = await applyAll(baseConfig({ function: [fn({ reserved_concurrency: 5 })] }), state);
    expect(created.calls.find((c) => c.name === "PutFunctionConcurrencyCommand")!.input).toEqual({
      FunctionName: "app-foo",
      ReservedConcurrentExecutions: 5,
    });

    const raised = await applyAll(baseConfig({ function: [fn({ reserved_concurrency: 8 })] }), state);
    expect(raised.names()).toEqual(["UpdateFunctionConfigurationCommand", "GetFunctionConfigurationCommand", "PutFunctionConcurrencyCommand"]);

    const cleared = await applyAll(baseConfig(), state);
    expect(cleared.names()).toContain("DeleteFunctionConcurrencyCommand");
  });

  test("authenticated: none creates a public URL and ignores invokers", async () => {
    const aws = await applyAll(baseConfig({ authenticated: "none", invoker: [ROLE] }), emptyState());
    expect(aws.calls.find((c) => c.name === "CreateFunctionUrlConfigCommand")!.input.AuthType).toBe("NONE");
    expect(aws.calls.filter((c) => c.name === "AddPermissionCommand").map((c) => c.input)).toMatchObject([
      { Action: "lambda:InvokeFunctionUrl", Principal: "*", FunctionUrlAuthType: "NONE" },
      { Action: "lambda:InvokeFunction", Principal: "*", InvokedViaFunctionUrl: true },
    ]);
  });

  test("switching between iam and none swaps the URL auth type and its permissions", async () => {
    const state = emptyState();
    await applyAll(baseConfig({ invoker: [ROLE] }), state);

    const toPublic = baseConfig({ authenticated: "none", invoker: [ROLE] });
    expect(plan(toPublic, state).find((a) => a.kind === "function")).toMatchObject({ op: "update", changes: ["auth", "invokers"] });
    const opened = await applyAll(toPublic, state);
    expect(opened.names()).toEqual([
      "UpdateFunctionUrlConfigCommand",
      "RemovePermissionCommand",
      "RemovePermissionCommand",
      "AddPermissionCommand",
      "AddPermissionCommand",
    ]);
    expect(opened.calls[0]!.input.AuthType).toBe("NONE");

    const closed = await applyAll(baseConfig({ invoker: [ROLE] }), state);
    expect(closed.calls[0]!.input.AuthType).toBe("AWS_IAM");
    expect(closed.calls.filter((c) => c.name === "RemovePermissionCommand").map((c) => c.input.StatementId)).toEqual([
      "cloudgear-public-url",
      "cloudgear-public-invoke",
    ]);
    expect(closed.calls.filter((c) => c.name === "AddPermissionCommand").every((c) => c.input.Principal === ROLE)).toBe(true);
  });

  test("retrying after a partial permission update tolerates statements that already exist", async () => {
    const aws = fakeAws({
      AddPermissionCommand: () => {
        throw Object.assign(new Error("The statement id (cloudgear-url-abc) provided already exists. Please provide a new statement id."), {
          name: "ResourceConflictException",
        });
      },
    });
    await expect(applyAll(baseConfig({ invoker: [ROLE] }), emptyState(), aws)).resolves.toBeDefined();
    expect(aws.names().filter((n) => n === "AddPermissionCommand")).toHaveLength(2);
  });

  test("a conflict because the function is mid-update is not swallowed", async () => {
    const aws = fakeAws({
      AddPermissionCommand: () => {
        throw Object.assign(new Error("The operation cannot be performed at this time. An update is in progress for resource."), {
          name: "ResourceConflictException",
        });
      },
    });
    await expect(applyAll(baseConfig({ invoker: [ROLE] }), emptyState(), aws)).rejects.toThrow(/update is in progress/);
  });

  test("other permission errors still fail", async () => {
    const aws = fakeAws({
      AddPermissionCommand: () => {
        throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      },
    });
    await expect(applyAll(baseConfig({ invoker: [ROLE] }), emptyState(), aws)).rejects.toThrow("denied");
  });

  test("endpoints record the authentication mode", async () => {
    const state = emptyState();
    await applyAll(baseConfig({ authenticated: "none" }), state);
    expect(endpointsFrom(baseConfig({ authenticated: "none" }), state).auth).toBe("none");
  });

  test("endpoints are marked as IAM-authenticated", async () => {
    const state = emptyState();
    await applyAll(baseConfig(), state);
    expect(endpointsFrom(baseConfig(), state).auth).toBe("iam");
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
