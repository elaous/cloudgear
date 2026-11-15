import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Registry } from "@cloudgear/registry";
import { analyzeApp } from "../src/analyze/app";
import type { Drivers } from "../src/deploy/apply";
import { apply } from "../src/deploy/apply";
import { adoptEntries } from "../src/deploy/adopt";
import { awsDrivers, type SendClient } from "../src/deploy/aws";
import { lifecyclePolicy, writtenByCloudgear } from "../src/deploy/aws/ecr";
import { plan } from "../src/deploy/plan";
import { stateKey } from "../src/deploy/state";
import { validateOptions } from "../src/providers";
import type { CloudgearConfig } from "../src/config/schema";
import { generate } from "../src/generate";
import { baseConfig, emptyState } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "registry", `${name}.ts`);
const KEY = stateKey({ type: "@aws.ECR", name: "registry.app" });

interface Repo {
  repositoryArn: string;
  repositoryUri: string;
  imageTagMutability: string;
  imageScanningConfiguration: { scanOnPush: boolean };
  lifecycle?: string;
  tags?: unknown;
}

function fakeEcr(initial: Record<string, Partial<Repo>> = {}) {
  const repos = new Map<string, Repo>(
    Object.entries(initial).map(([name, repo]) => [name, { repositoryArn: `arn:aws:ecr:eu-west-1:1:repository/${name}`, repositoryUri: `1.dkr.ecr.eu-west-1.amazonaws.com/${name}`, imageTagMutability: "MUTABLE", imageScanningConfiguration: { scanOnPush: false }, ...repo }]),
  );
  const calls: { name: string; input: any }[] = [];
  const err = (name: string) => Object.assign(new Error(name), { name });
  const client: SendClient = {
    async send(command) {
      const name = command.constructor.name as string;
      const input = command.input;
      calls.push({ name, input });
      const repo = repos.get(input.repositoryName ?? input.repositoryNames?.[0]);
      switch (name) {
        case "DescribeRepositoriesCommand":
          if (!repo) throw err("RepositoryNotFoundException");
          return { repositories: [repo] };
        case "CreateRepositoryCommand": {
          const created: Repo = { repositoryArn: `arn:aws:ecr:eu-west-1:1:repository/${input.repositoryName}`, repositoryUri: `1.dkr.ecr.eu-west-1.amazonaws.com/${input.repositoryName}`, imageTagMutability: input.imageTagMutability, imageScanningConfiguration: input.imageScanningConfiguration, tags: input.tags };
          repos.set(input.repositoryName, created);
          return { repository: created };
        }
        case "PutImageScanningConfigurationCommand":
          repo!.imageScanningConfiguration = input.imageScanningConfiguration;
          return {};
        case "PutImageTagMutabilityCommand":
          repo!.imageTagMutability = input.imageTagMutability;
          return {};
        case "GetLifecyclePolicyCommand":
          if (!repo?.lifecycle) throw err("LifecyclePolicyNotFoundException");
          return { lifecyclePolicyText: repo.lifecycle };
        case "PutLifecyclePolicyCommand":
          repo!.lifecycle = input.lifecyclePolicyText;
          return {};
        case "DeleteLifecyclePolicyCommand":
          delete repo!.lifecycle;
          return {};
        case "DeleteRepositoryCommand":
          if (!repo) throw err("RepositoryNotFoundException");
          repos.delete(input.repositoryName);
          return {};
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const logs: string[] = [];
  const drivers = awsDrivers({
    region: "eu-west-1",
    tags: { "cloudgear:project": "app" },
    readBundle: () => new Uint8Array(),
    clients: { ecr: client },
    log: (m) => void logs.push(m),
  });
  return { repos, calls, drivers, logs, names: () => calls.map((c) => c.name) };
}

const configWith = (options?: Record<string, string>): CloudgearConfig =>
  baseConfig({ resource: [{ name: "registry.app", type: "@aws.ECR", physical_name: "app", dry: false, source: "setup.ts:1", ...(options ? { options } : {}) }], function: [] });
const empty = () => baseConfig({ resource: [], function: [] });

async function applyConfig(config: CloudgearConfig, state: ReturnType<typeof emptyState>, drivers: Drivers) {
  await apply(plan(config, state), state, drivers, { save: () => {}, log: () => {} });
}

describe("Registry", () => {
  test("validates the provider, name and retention without side effects", () => {
    expect(new Registry("aws", "tranquilo/web", { keepUntaggedDays: false }).name).toBe("tranquilo/web");
    expect(() => new Registry("gcp" as "aws", "app")).toThrow(/not supported yet/);
    expect(() => new Registry("aws", "Bad Name")).toThrow(/Invalid repository name/);
    expect(() => new Registry("aws", "a")).toThrow(/Invalid repository name/);
    expect(() => new Registry("aws", "app", { keepUntaggedDays: 0 })).toThrow(/keepUntaggedDays must be/);
    expect(() => new Registry("aws", "app", { keepUntaggedDays: 366 })).toThrow(/keepUntaggedDays must be/);
  });
});

describe("analysis", () => {
  test("registries become @aws.ECR resources carrying only what was set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
    const { config } = await generate({ entry: fixture("basic"), configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "app" });
    expect(config.resource.map((r) => [r.name, r.type, r.physical_name, r.options])).toEqual([
      ["registry.tranquilo/web", "@aws.ECR", "tranquilo/web", { scan_on_push: "false", immutable_tags: "true", keep_untagged_days: "30", allow_destroy: "true" }],
      ["registry.tranquilo/api", "@aws.ECR", "tranquilo/api", { keep_untagged_days: "off" }],
      ["registry.tranquilo/worker", "@aws.ECR", "tranquilo/worker", {}],
    ]);
  });

  test("keepUntaggedDays: false written with a cast is still recognised", () => {
    expect(analyzeApp(fixture("false-const")).registries[0]!.keepUntaggedDays).toBe(false);
  });

  test("duplicates, unknown options, a zero retention and a bad name are errors", () => {
    expect(() => analyzeApp(fixture("duplicate"))).toThrow(/Registry "same" is also declared at/);
    expect(() => analyzeApp(fixture("typo"))).toThrow(/unknown Registry option "scanOnpush" \(supported: scanOnPush, immutableTags, keepUntaggedDays, allowDestroy\)/);
    expect(() => analyzeApp(fixture("zero-days"))).toThrow(/keepUntaggedDays must be a whole number from 1 to 365/);
    expect(() => analyzeApp(fixture("bad-name"))).toThrow(/Invalid repository name "Bad Name"/);
  });
});

describe("ecr driver", () => {
  test("creates a repository with scanning, tags and the default 14-day untagged expiry", async () => {
    const ecr = fakeEcr();
    const state = emptyState();
    await applyConfig(configWith(), state, ecr.drivers);
    const repo = ecr.repos.get("app")!;
    expect(repo.imageScanningConfiguration).toEqual({ scanOnPush: true });
    expect(repo.imageTagMutability).toBe("MUTABLE");
    expect(repo.lifecycle).toBe(lifecyclePolicy(14));
    expect(repo.tags).toEqual(expect.arrayContaining([{ Key: "cloudgear:project", Value: "app" }]));
    expect(state.entries[KEY]!.outputs).toEqual({ arn: repo.repositoryArn, uri: repo.repositoryUri, lifecycle: "managed" });
    expect(plan(configWith(), state).every((a) => a.op === "noop")).toBe(true);
  });

  test("adopts an existing repository and only changes what differs", async () => {
    const ecr = fakeEcr({ app: { imageScanningConfiguration: { scanOnPush: false }, lifecycle: lifecyclePolicy(14) } });
    const state = emptyState();
    await applyConfig(configWith({ immutable_tags: "true" }), state, ecr.drivers);
    expect(ecr.names()).not.toContain("CreateRepositoryCommand");
    expect(ecr.names().filter((n) => n.startsWith("Put")).sort()).toEqual(["PutImageScanningConfigurationCommand", "PutImageTagMutabilityCommand"]);
    expect(ecr.repos.get("app")!.imageTagMutability).toBe("IMMUTABLE");
    expect(ecr.logs).toContain("adopted existing ECR repository app");
    expect(state.entries[KEY]!.outputs.lifecycle).toBe("managed");
  });

  test("never overwrites a lifecycle policy cloudgear did not write", async () => {
    const foreign = JSON.stringify({ rules: [{ rulePriority: 1, description: "mine", selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 5 }, action: { type: "expire" } }] });
    const blocked = fakeEcr({ app: { lifecycle: foreign } });
    await expect(applyConfig(configWith(), emptyState(), blocked.drivers)).rejects.toThrow(/already has a lifecycle policy that cloudgear did not write; set keepUntaggedDays: false/);
    expect(blocked.repos.get("app")!.lifecycle).toBe(foreign);

    const left = fakeEcr({ app: { lifecycle: foreign } });
    await applyConfig(configWith({ keep_untagged_days: "off" }), emptyState(), left.drivers);
    expect(left.repos.get("app")!.lifecycle).toBe(foreign);
    expect(left.names().some((n) => n.includes("LifecyclePolicy") && n !== "GetLifecyclePolicyCommand")).toBe(false);
  });

  test("changing the retention rewrites the policy, and turning it off removes only a managed one", async () => {
    const ecr = fakeEcr();
    const state = emptyState();
    await applyConfig(configWith(), state, ecr.drivers);
    await applyConfig(configWith({ keep_untagged_days: "30" }), state, ecr.drivers);
    expect(ecr.repos.get("app")!.lifecycle).toBe(lifecyclePolicy(30));
    await applyConfig(configWith({ keep_untagged_days: "off" }), state, ecr.drivers);
    expect(ecr.repos.get("app")!.lifecycle).toBeUndefined();
    expect(state.entries[KEY]!.outputs.lifecycle).toBe("unmanaged");
  });

  test("destroy refuses an unprotected repository before changing anything, and force-deletes a protected one", async () => {
    const guarded = fakeEcr();
    const savedGuarded = emptyState();
    await applyConfig(configWith(), savedGuarded, guarded.drivers);
    await expect(applyConfig(empty(), savedGuarded, guarded.drivers)).rejects.toThrow(/^Nothing was changed\. Refusing to delete ECR repository "app"/);
    expect(guarded.repos.size).toBe(1);

    const open = fakeEcr();
    const savedOpen = emptyState();
    await applyConfig(configWith({ allow_destroy: "true" }), savedOpen, open.drivers);
    await applyConfig(empty(), savedOpen, open.drivers);
    expect(open.repos.size).toBe(0);
    expect(open.calls.find((c) => c.name === "DeleteRepositoryCommand")!.input).toEqual({ repositoryName: "app", force: true });
    expect(savedOpen.entries).toEqual({});
  });

  test("a repository that is already gone does not fail the delete", async () => {
    const ecr = fakeEcr();
    const state = emptyState();
    await applyConfig(configWith({ allow_destroy: "true" }), state, ecr.drivers);
    ecr.repos.clear();
    await applyConfig(empty(), state, ecr.drivers);
    expect(state.entries).toEqual({});
  });

  test("adopt reads only: it records the spec when the repository matches and explains when not", async () => {
    const matching = fakeEcr({ app: { imageScanningConfiguration: { scanOnPush: true }, lifecycle: lifecyclePolicy(14) } });
    const [entry] = plan(configWith({ allow_destroy: "true" }), emptyState()).map((a) => a.desired!);
    const ok = await matching.drivers["@aws.ECR"]!.adopt!(entry!, { entry: () => undefined });
    expect(ok!.spec).toEqual({ physical_name: "app", region: "" });
    expect(ok!.outputs.lifecycle).toBe("managed");
    expect(matching.names().every((n) => n === "DescribeRepositoriesCommand" || n === "GetLifecyclePolicyCommand")).toBe(true);

    const differing = fakeEcr({ app: { imageScanningConfiguration: { scanOnPush: false } } });
    const [plain] = plan(configWith(), emptyState()).map((a) => a.desired!);
    const mismatch = await differing.drivers["@aws.ECR"]!.adopt!(plain!, { entry: () => undefined });
    expect(mismatch!.spec).toEqual({ physical_name: "app" });
    expect(mismatch!.notes![0]).toMatch(/scan on push is off \(config: on\); it has no lifecycle policy for untagged images/);
    expect(await fakeEcr().drivers["@aws.ECR"]!.adopt!(plain!, { entry: () => undefined })).toBeUndefined();
  });
});

const FOREIGN = JSON.stringify({ rules: [{ rulePriority: 1, description: "mine", selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 5 }, action: { type: "expire" } }] });

describe("safety", () => {
  test("tag settings with exclusions are never changed or reported", async () => {
    for (const mutability of ["IMMUTABLE_WITH_EXCLUSION", "MUTABLE_WITH_EXCLUSION"]) {
      for (const options of [{ immutable_tags: "true" }, undefined]) {
        const ecr = fakeEcr({ app: { imageTagMutability: mutability, imageScanningConfiguration: { scanOnPush: true }, lifecycle: lifecyclePolicy(14) } });
        await applyConfig(configWith(options), emptyState(), ecr.drivers);
        expect(ecr.names()).not.toContain("PutImageTagMutabilityCommand");
        expect(ecr.repos.get("app")!.imageTagMutability).toBe(mutability);
        const [entry] = plan(configWith(options), emptyState()).map((a) => a.desired!);
        expect((await ecr.drivers["@aws.ECR"]!.adopt!(entry!, { entry: () => undefined }))!.notes).toBeUndefined();
      }
    }
  });

  test("a policy edited out of band is not deleted or overwritten later", async () => {
    const ecr = fakeEcr();
    const state = emptyState();
    await applyConfig(configWith(), state, ecr.drivers);
    ecr.repos.get("app")!.lifecycle = FOREIGN;
    await applyConfig(configWith({ keep_untagged_days: "off" }), state, ecr.drivers);
    expect(ecr.repos.get("app")!.lifecycle).toBe(FOREIGN);
    await expect(applyConfig(configWith({ keep_untagged_days: "30" }), state, ecr.drivers)).rejects.toThrow(/did not write/);
    expect(ecr.repos.get("app")!.lifecycle).toBe(FOREIGN);
  });

  test("a cloudgear-style policy with other days is rewritten even with no state", async () => {
    const ecr = fakeEcr({ app: { imageScanningConfiguration: { scanOnPush: true }, lifecycle: lifecyclePolicy(90) } });
    await applyConfig(configWith(), emptyState(), ecr.drivers);
    expect(ecr.repos.get("app")!.lifecycle).toBe(lifecyclePolicy(14));
    expect(writtenByCloudgear(lifecyclePolicy(7))).toBe(true);
    expect(writtenByCloudgear(FOREIGN)).toBe(false);
    expect(writtenByCloudgear("not json")).toBe(false);
  });

  test("a foreign policy stops apply before any setting changes", async () => {
    const ecr = fakeEcr({ app: { imageScanningConfiguration: { scanOnPush: false }, imageTagMutability: "MUTABLE", lifecycle: FOREIGN } });
    await expect(applyConfig(configWith({ immutable_tags: "true" }), emptyState(), ecr.drivers)).rejects.toThrow(/did not write/);
    expect(ecr.names().filter((n) => n.startsWith("Put") || n.startsWith("Delete") || n.startsWith("Create"))).toEqual([]);
  });

  test("turning allowDestroy off and then removing the declaration is refused", async () => {
    const ecr = fakeEcr();
    const state = emptyState();
    await applyConfig(configWith({ allow_destroy: "true" }), state, ecr.drivers);
    await applyConfig(configWith(), state, ecr.drivers);
    await expect(applyConfig(empty(), state, ecr.drivers)).rejects.toThrow(/Nothing was changed/);
    expect(ecr.repos.size).toBe(1);
  });

  test("import grants no deletion; the next apply does", async () => {
    const ecr = fakeEcr({ app: { imageScanningConfiguration: { scanOnPush: true }, lifecycle: lifecyclePolicy(14) } });
    const state = emptyState();
    const config = configWith({ allow_destroy: "true" });
    const result = await adoptEntries(plan(config, state), state, ecr.drivers, () => true);
    expect(result.adopted).toHaveLength(1);
    expect(ecr.names().every((n) => n === "DescribeRepositoriesCommand" || n === "GetLifecyclePolicyCommand")).toBe(true);
    await expect(applyConfig(empty(), state, ecr.drivers)).rejects.toThrow(/Nothing was changed/);
    const next = plan(config, state);
    expect(next.map((a) => a.op)).toEqual(["update"]);
    await applyConfig(config, state, ecr.drivers);
    await applyConfig(empty(), state, ecr.drivers);
    expect(ecr.repos.size).toBe(0);
  });
});

describe("option validation", () => {
  test("ECR options are checked", () => {
    validateOptions("aws", "@aws.ECR", { scan_on_push: "false", immutable_tags: "true", keep_untagged_days: "off", allow_destroy: "true" }, "r");
    validateOptions("aws", "@aws.ECR", { keep_untagged_days: "365" }, "r");
    expect(() => validateOptions("aws", "@aws.ECR", { keep_untagged_days: "0" }, "r")).toThrow(/must be an integer from 1 to 365, or "off"/);
    expect(() => validateOptions("aws", "@aws.ECR", { keep_untagged_days: "366" }, "r")).toThrow(/must be an integer/);
    expect(() => validateOptions("aws", "@aws.ECR", { allow_destroy: "false" }, "r")).toThrow(/must be one of true/);
    expect(() => validateOptions("aws", "@aws.ECR", { tier: "x" }, "r")).toThrow(/unknown option "tier"/);
  });
});
