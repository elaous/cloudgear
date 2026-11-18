import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adoptEntries } from "../src/deploy/adopt";
import { apply, type Drivers } from "../src/deploy/apply";
import { gcpDrivers, labelsFrom, resolveProject } from "../src/deploy/gcp";
import type { StorageLike } from "../src/deploy/gcp/storage";
import { plan } from "../src/deploy/plan";
import { stateKey } from "../src/deploy/state";
import { validateOptions } from "../src/providers";
import type { CloudgearConfig } from "../src/config/schema";
import { generate } from "../src/generate";
import { baseConfig, emptyState, fn } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "gcp", `${name}.ts`);
const KEY = stateKey({ type: "@gcp.GCS", name: "assets" });

interface Bucket {
  location: string;
  versioning: boolean;
  objects: number;
  metadata: Record<string, any>;
}

class ApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function fakeGcs(initial: Record<string, Partial<Bucket>> = {}, opts: { forbidden?: string[] } = {}) {
  const buckets = new Map<string, Bucket>(Object.entries(initial).map(([name, b]) => [name, { location: "US", versioning: false, objects: 0, metadata: {}, ...b }]));
  const calls: { project: string; op: string; name: string; input?: any }[] = [];
  const clients: string[] = [];
  const storage = (project: string): StorageLike => {
    clients.push(project);
    return {
      async createBucket(name, metadata) {
        calls.push({ project, op: "create", name, input: metadata });
        if (buckets.has(name)) throw new ApiError(409, "You already own this bucket. Please select another name.");
        buckets.set(name, { location: String(metadata.location), versioning: (metadata.versioning as { enabled: boolean }).enabled, objects: 0, metadata });
        return [{}];
      },
      bucket(name) {
        return {
          async getMetadata() {
            calls.push({ project, op: "get", name });
            if (opts.forbidden?.includes(name)) throw new ApiError(403, "forbidden");
            const found = buckets.get(name);
            if (!found) throw new ApiError(404, "Not Found");
            return [{ location: found.location, versioning: { enabled: found.versioning } }];
          },
          async setMetadata(metadata) {
            calls.push({ project, op: "set", name, input: metadata });
            const found = buckets.get(name);
            if (!found) throw new ApiError(404, "Not Found");
            if ((metadata.versioning as { enabled: boolean } | undefined) !== undefined) found.versioning = (metadata.versioning as { enabled: boolean }).enabled;
          },
          async delete() {
            calls.push({ project, op: "delete", name });
            const found = buckets.get(name);
            if (!found) throw new ApiError(404, "Not Found");
            if (found.objects > 0) throw new ApiError(409, "The bucket you tried to delete was not empty.");
            buckets.delete(name);
          },
        };
      },
    };
  };
  const logs: string[] = [];
  const drivers = gcpDrivers({ storage, defaultProject: async () => "adc-project-1", labels: { "cloudgear:project": "app", "cloudgear:managed-by": "cloudgear" }, log: (m) => void logs.push(m), env: {} });
  return { buckets, calls, clients, logs, drivers };
}

const bucketResource = (options: Record<string, string> = {}) => ({ name: "assets", type: "@gcp.GCS", physical_name: "assets", dry: false, source: "setup.ts:1", ...(Object.keys(options).length ? { options } : {}) });
const configWith = (options?: Record<string, string>): CloudgearConfig => baseConfig({ provider: "gcp", resource: [bucketResource(options)], function: [] });
const empty = () => baseConfig({ provider: "gcp", resource: [], function: [] });

async function applyConfig(config: CloudgearConfig, state: ReturnType<typeof emptyState>, drivers: Drivers) {
  await apply(plan(config, state), state, drivers, { save: () => {}, log: () => {} });
}

describe("project and labels", () => {
  const deps = (project?: string) => ({ defaultProject: async () => project });

  test("a resource's own project wins, then GOOGLE_CLOUD_PROJECT, then the credentials'", async () => {
    expect(await resolveProject({ ...deps("adc"), env: { GOOGLE_CLOUD_PROJECT: "env" } }, "own", "x")).toBe("own");
    expect(await resolveProject({ ...deps("adc"), env: { GOOGLE_CLOUD_PROJECT: "env" } }, undefined, "x")).toBe("env");
    expect(await resolveProject({ ...deps("adc"), env: {} }, undefined, "x")).toBe("adc");
    await expect(resolveProject({ ...deps(undefined), env: {} }, undefined, 'Bucket "assets"')).rejects.toThrow(/Bucket "assets" has no GCP project; set its project option, GOOGLE_CLOUD_PROJECT/);
    await expect(resolveProject({ defaultProject: async () => { throw new Error("no credentials"); }, env: {} }, undefined, "x")).rejects.toThrow(/has no GCP project/);
  });

  test("tags become valid GCP labels", () => {
    const labels = labelsFrom({ "cloudgear:project": "My App!", "9bad": "x", Author: "Sam Aouar" }, "assets");
    expect(labels).toEqual({ "cloudgear_project": "my_app_", bad: "x", author: "sam_aouar", "cloudgear_resource": "assets" });
    expect(Object.values(labelsFrom({ k: "v".repeat(100) }, "r")).every((v) => v.length <= 63)).toBe(true);
  });
});

describe("analysis", () => {
  test("a gcp BlobStore becomes a @gcp.GCS resource with its options", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gcp-"));
    const { config } = await generate({ entry: fixture("bucket"), configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "app" });
    expect(config.resource.map((r) => [r.name, r.type, r.physical_name, r.options])).toEqual([
      ["assets", "@gcp.GCS", "assets", { project: "my-proj-123", location: "us-central1", versioning: "true", storage_class: "NEARLINE" }],
      ["plain", "@gcp.GCS", "plain", undefined],
    ]);
  });
});

describe("gcs driver", () => {
  test("creates a private, uniform-access bucket in the default location with labels", async () => {
    const gcs = fakeGcs();
    const state = emptyState();
    await applyConfig(configWith({ project: "my-proj-123" }), state, gcs.drivers);
    expect(gcs.calls[0]).toMatchObject({ project: "my-proj-123", op: "create", name: "assets" });
    expect(gcs.calls[0]!.input).toMatchObject({
      location: "US",
      versioning: { enabled: false },
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
      labels: { cloudgear_project: "app", "cloudgear_managed-by": "cloudgear", cloudgear_resource: "assets" },
    });
    expect("storageClass" in gcs.calls[0]!.input).toBe(false);
    expect(state.entries[KEY]!.outputs).toEqual({ name: "assets", location: "US", project: "my-proj-123" });
    expect(plan(configWith({ project: "my-proj-123" }), state).every((a) => a.op === "noop")).toBe(true);
  });

  test("location, storage class and versioning are passed on, and the project falls back to the credentials'", async () => {
    const gcs = fakeGcs();
    await applyConfig(configWith({ location: "us-central1", storage_class: "COLDLINE", versioning: "true" }), emptyState(), gcs.drivers);
    expect(gcs.calls[0]).toMatchObject({ project: "adc-project-1" });
    expect(gcs.calls[0]!.input).toMatchObject({ location: "US-CENTRAL1", storageClass: "COLDLINE", versioning: { enabled: true } });
  });

  test("a bucket name that is taken says so and points at import", async () => {
    const gcs = fakeGcs({ assets: {} });
    await expect(applyConfig(configWith(), emptyState(), gcs.drivers)).rejects.toThrow(/Bucket "assets" already exists \(bucket names are global\); run `cloudgear import` if it is yours/);
  });

  test("versioning can be turned on and off, and the location cannot change", async () => {
    const gcs = fakeGcs();
    const state = emptyState();
    await applyConfig(configWith({ project: "my-proj-123" }), state, gcs.drivers);
    await applyConfig(configWith({ project: "my-proj-123", versioning: "true" }), state, gcs.drivers);
    expect(gcs.buckets.get("assets")!.versioning).toBe(true);
    await applyConfig(configWith({ project: "my-proj-123", versioning: "false" }), state, gcs.drivers);
    expect(gcs.buckets.get("assets")!.versioning).toBe(false);
    await expect(applyConfig(configWith({ project: "my-proj-123", location: "EU" }), state, gcs.drivers)).rejects.toThrow(/cannot move from US to EU; destroy it \(after emptying it\)/);
  });

  test("delete removes an empty bucket, tolerates a missing one and refuses a bucket with objects", async () => {
    const gcs = fakeGcs();
    const state = emptyState();
    await applyConfig(configWith(), state, gcs.drivers);
    await applyConfig(empty(), state, gcs.drivers);
    expect(gcs.buckets.size).toBe(0);

    const missing = fakeGcs();
    const second = emptyState();
    await applyConfig(configWith(), second, missing.drivers);
    missing.buckets.clear();
    await applyConfig(empty(), second, missing.drivers);
    expect(second.entries).toEqual({});

    const full = fakeGcs();
    const third = emptyState();
    await applyConfig(configWith(), third, full.drivers);
    full.buckets.get("assets")!.objects = 3;
    await expect(applyConfig(empty(), third, full.drivers)).rejects.toThrow(/Bucket "assets" is not empty; empty it, or run cloudgear import to keep it/);
    expect(full.buckets.size).toBe(1);
    expect(third.entries[KEY]).toBeDefined();
  });

  test("import records a bucket and never changes it, even on apply and destroy", async () => {
    const gcs = fakeGcs({ assets: { location: "EU", objects: 5 } });
    const state = emptyState();
    const config = configWith({ project: "my-proj-123" });
    const result = await adoptEntries(plan(config, state), state, gcs.drivers, () => true);
    expect(result.adopted).toHaveLength(1);
    expect(state.entries[KEY]).toMatchObject({ imported: true, outputs: { name: "assets", location: "EU", project: "my-proj-123" } });
    expect(gcs.calls.every((c) => c.op === "get")).toBe(true);
    await applyConfig(configWith({ project: "my-proj-123", versioning: "true", location: "US" }), state, gcs.drivers);
    await applyConfig(empty(), state, gcs.drivers);
    expect(gcs.calls.filter((c) => c.op !== "get")).toEqual([]);
    expect(gcs.buckets.size).toBe(1);
    expect(state.entries[KEY]).toBeUndefined();
  });

  test("adopt reports a missing bucket, and one the credentials cannot read", async () => {
    const [entry] = plan(configWith({ project: "my-proj-123" }), emptyState()).map((a) => a.desired!);
    expect(await fakeGcs().drivers["@gcp.GCS"]!.adopt!(entry!, { entry: () => undefined })).toBeUndefined();
    await expect(fakeGcs({ assets: {} }, { forbidden: ["assets"] }).drivers["@gcp.GCS"]!.adopt!(entry!, { entry: () => undefined })).rejects.toThrow(/exists but these credentials cannot read it \(it may belong to another project\)/);
  });

  test("a bucket with no project anywhere fails before any call", async () => {
    const calls: string[] = [];
    const drivers = gcpDrivers({ storage: () => { calls.push("client"); throw new Error("unreachable"); }, defaultProject: async () => undefined, log: () => {}, env: {} });
    await expect(applyConfig(configWith(), emptyState(), drivers)).rejects.toThrow(/has no GCP project/);
    expect(calls).toEqual([]);
  });
});

describe("types without a driver", () => {
  test("apply stops before changing anything when the plan holds a type no driver handles", async () => {
    const gcs = fakeGcs();
    const config = baseConfig({
      provider: "gcp",
      resource: [bucketResource({ project: "my-proj-123" })],
      function: [fn({ type: "@gcp.CloudFunction", permission: [], env: [] })],
    });
    await expect(applyConfig(config, emptyState(), gcs.drivers)).rejects.toThrow(/^Nothing was changed\. cloudgear cannot deploy @gcp.CloudFunction yet/);
    expect(gcs.calls).toEqual([]);
  });
});

describe("option validation", () => {
  test("GCS options are checked", () => {
    validateOptions("gcp", "@gcp.GCS", { versioning: "true", project: "my-proj-123", location: "us-central1", storage_class: "STANDARD" }, "b");
    expect(() => validateOptions("gcp", "@gcp.GCS", { project: "Bad_Project" }, "b")).toThrow(/must be a GCP project id/);
    expect(() => validateOptions("gcp", "@gcp.GCS", { location: "1" }, "b")).toThrow(/must be a bucket location/);
    expect(() => validateOptions("gcp", "@gcp.GCS", { storage_class: "FAST" }, "b")).toThrow(/must be one of STANDARD, NEARLINE, COLDLINE, ARCHIVE/);
    expect(() => validateOptions("gcp", "@gcp.GCS", { tier: "x" }, "b")).toThrow(/unknown option "tier"/);
  });
});
