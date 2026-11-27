import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adoptEntries } from "../src/deploy/adopt";
import { apply, type Drivers } from "../src/deploy/apply";
import { gcpDrivers, labelsFrom, resolveProject } from "../src/deploy/gcp";
import type { StorageLike } from "../src/deploy/gcp/storage";
import { formatPlan, hasChanges, plan } from "../src/deploy/plan";
import { listSiteFiles, siteFilesHash } from "../src/deploy/site-files";
import { withSiteChanges } from "../src/deploy/site-plan";
import { readManifest } from "../src/deploy/site-sync";
import { stateKey } from "../src/deploy/state";
import { validateOptions } from "../src/providers";
import type { CloudgearConfig } from "../src/config/schema";
import { generate } from "../src/generate";
import { baseConfig, emptyState, fn } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "gcp", `${name}.ts`);
const KEY = stateKey({ type: "@gcp.GCS", name: "assets" });

interface StoredFile {
  body: string;
  contentType: string;
  cacheControl?: string;
  sha256?: string;
}

interface Bucket {
  location: string;
  versioning: boolean;
  objects: number;
  metadata: Record<string, any>;
  files: Map<string, StoredFile>;
}

class ApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function fakeGcs(initial: Record<string, Partial<Bucket>> = {}, opts: { forbidden?: string[]; failSave?: (key: string) => Error | undefined; failSet?: (metadata: Record<string, unknown>) => Error | undefined; siteRoot?: string } = {}) {
  const buckets = new Map<string, Bucket>(Object.entries(initial).map(([name, b]) => [name, { location: "US", versioning: false, objects: 0, metadata: {}, files: new Map(), ...b }]));
  const calls: { project: string; op: string; name: string; input?: any }[] = [];
  const clients: string[] = [];
  const storage = (project: string): StorageLike => {
    clients.push(project);
    return {
      async createBucket(name, metadata) {
        calls.push({ project, op: "create", name, input: metadata });
        if (buckets.has(name)) throw new ApiError(409, "You already own this bucket. Please select another name.");
        buckets.set(name, { location: String(metadata.location), versioning: (metadata.versioning as { enabled: boolean }).enabled, objects: 0, metadata, files: new Map() });
        return [{}];
      },
      bucket(name) {
        return {
          file(key) {
            return {
              async save(data, options) {
                calls.push({ project, op: "save", name, input: { key, contentType: options.contentType, metadata: options.metadata } });
                const injected = opts.failSave?.(key);
                if (injected) throw injected;
                const found = buckets.get(name);
                if (!found) throw new ApiError(404, "Not Found");
                found.files.set(key, { body: data.toString(), contentType: options.contentType, cacheControl: options.metadata.cacheControl, sha256: options.metadata.metadata.sha256 });
                found.objects = found.files.size;
              },
              async delete(options) {
                calls.push({ project, op: "delete-file", name, input: { key } });
                const found = buckets.get(name);
                if (!found || (!found.files.has(key) && !options?.ignoreNotFound)) throw new ApiError(404, "Not Found");
                found.files.delete(key);
                found.objects = found.files.size;
              },
            };
          },
          iam: { getPolicy: async () => [{ bindings: [] }], setPolicy: async () => ({}) },
          async getMetadata() {
            calls.push({ project, op: "get", name });
            if (opts.forbidden?.includes(name)) throw new ApiError(403, "forbidden");
            const found = buckets.get(name);
            if (!found) throw new ApiError(404, "Not Found");
            return [{ location: found.location, versioning: { enabled: found.versioning } }];
          },
          async setMetadata(metadata) {
            calls.push({ project, op: "set", name, input: metadata });
            const injected = opts.failSet?.(metadata);
            if (injected) throw injected;
            const found = buckets.get(name);
            if (!found) throw new ApiError(404, "Not Found");
            if ((metadata.versioning as { enabled: boolean } | undefined) !== undefined) found.versioning = (metadata.versioning as { enabled: boolean }).enabled;
            for (const key of ["website", "cors"]) {
              if (!(key in metadata)) continue;
              const value = metadata[key];
              if (value === null) delete found.metadata[key];
              else if (key === "website") {
                // PATCH merges nested objects; a null field is removed.
                const merged = { ...(found.metadata.website ?? {}), ...(value as Record<string, unknown>) };
                for (const [field, v] of Object.entries(merged)) if (v === null) delete merged[field];
                found.metadata.website = merged;
              } else found.metadata[key] = value;
            }
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
  const drivers = gcpDrivers({ storage, defaultProject: async () => "adc-project-1", labels: { "cloudgear:project": "app", "cloudgear:managed-by": "cloudgear" }, log: (m) => void logs.push(m), env: {}, siteRoot: opts.siteRoot });
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

  test("a credentials failure is shown with the missing-project message, and the real environment is read by default", async () => {
    await expect(resolveProject({ defaultProject: async () => { throw new Error("Could not load the default credentials"); }, env: {} }, undefined, "Bucket \"assets\"")).rejects.toThrow(/has no GCP project.*\(looking it up failed: Could not load the default credentials\)/);
    const saved = process.env.GOOGLE_CLOUD_PROJECT;
    process.env.GOOGLE_CLOUD_PROJECT = "from-process-env";
    try {
      expect(await resolveProject({ defaultProject: async () => "adc" }, undefined, "x")).toBe("from-process-env");
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      else process.env.GOOGLE_CLOUD_PROJECT = saved;
    }
  });

  test("tags that become the same label, or use the reserved prefix, are errors", () => {
    expect(() => labelsFrom({ Env: "a", env: "b" }, "r")).toThrow(/Tags "Env" and "env" both become the GCP label "env"; rename one/);
    expect(() => labelsFrom({ "a:b": "1", a_b: "2" }, "r")).toThrow(/both become the GCP label "a_b"/);
    expect(() => labelsFrom({ cloudgear_resource: "x" }, "r")).toThrow(/Tags "cloudgear_resource" and "cloudgear:resource" both become/);
    expect(() => labelsFrom({ googtag: "x" }, "r")).toThrow(/GCP reserves the "goog" prefix/);
    expect(() => labelsFrom({ "123": "x" }, "r")).toThrow(/cannot become a GCP label/);
    expect(labelsFrom({ a: "1", a_: "2" }, "r")).toMatchObject({ a: "1", a_: "2" });
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

  test("storage class changes are applied, a project change is refused, and both are never recorded without happening", async () => {
    const gcs = fakeGcs();
    const state = emptyState();
    await applyConfig(configWith({ project: "my-proj-123", storage_class: "STANDARD" }), state, gcs.drivers);
    await applyConfig(configWith({ project: "my-proj-123", storage_class: "COLDLINE", versioning: "true" }), state, gcs.drivers);
    const patch = gcs.calls.filter((c) => c.op === "set");
    expect(patch).toHaveLength(1);
    expect(patch[0]!.input).toEqual({ versioning: { enabled: true }, storageClass: "COLDLINE" });
    await expect(applyConfig(configWith({ project: "other-proj-456", storage_class: "COLDLINE", versioning: "true" }), state, gcs.drivers)).rejects.toThrow(/is in project my-proj-123 and cannot move to other-proj-456/);
    expect(gcs.calls.filter((c) => c.op === "set")).toHaveLength(1);
  });

  test("destroy finds the project again when the state has none recorded", async () => {
    const gcs = fakeGcs({ assets: {} });
    const state = emptyState();
    state.entries[KEY] = { kind: "resource", type: "@gcp.GCS", name: "assets", physical_name: "assets", spec: { physical_name: "assets", region: "", options: { project: "my-proj-123" } }, outputs: {}, deps: [] } as never;
    await applyConfig(empty(), state, gcs.drivers);
    expect(gcs.calls[0]).toMatchObject({ project: "my-proj-123", op: "delete" });
    expect(gcs.buckets.size).toBe(0);
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

describe("website buckets", () => {
  const roots: string[] = [];
  const project = (files: Record<string, string>): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gcs-site-"));
    roots.push(root);
    write(root, files);
    return root;
  };
  const write = (root: string, files: Record<string, string | null>) => {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(root, "dist", name);
      if (content === null) fs.rmSync(file, { force: true });
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
    }
  };
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const cache = [{ match: "assets/**", value: "public, max-age=60" }];
  const RULES = [{ origins: ["https://example.com"], methods: ["GET", "HEAD"], headers: ["content-type"], expose_headers: ["etag"], max_age_seconds: 3600 }];
  const FILES = { "index.html": "<h1>hi</h1>", "assets/app.js": "x=1" };

  const siteOptions = (root: string, extra: Record<string, string> = {}): Record<string, string> => {
    const files = listSiteFiles(path.join(root, "dist"), { include: [], exclude: [], cacheControl: cache }, root);
    return {
      index_document: "index.html",
      error_document: "404.html",
      cors: JSON.stringify(RULES),
      site_dir: "dist",
      site_cache_control: JSON.stringify(cache),
      site_files_hash: siteFilesHash(files),
      site_files_count: String(files.length),
      ...extra,
    };
  };

  async function deploy(root: string, options: Record<string, string>, state = emptyState(), fakeOptions: Parameters<typeof fakeGcs>[1] = {}, initial: Record<string, Partial<Bucket>> = {}) {
    const gcs = fakeGcs(initial, { siteRoot: root, ...fakeOptions });
    const actions = withSiteChanges(plan(configWith(options), state), root);
    await apply(actions, state, gcs.drivers, { save: () => {}, log: () => {} });
    return { gcs, state, actions };
  }

  const manifestOf = (state: ReturnType<typeof emptyState>) => Object.keys(readManifest(state.entries[KEY]!.outputs.site_manifest)).sort();
  const saves = (gcs: ReturnType<typeof fakeGcs>) => gcs.calls.filter((c) => c.op === "save");

  test("a new bucket gets the website, the CORS rules and every file with its headers", async () => {
    const root = project(FILES);
    const { gcs, state } = await deploy(root, siteOptions(root));
    expect(gcs.calls[0]!.input).toMatchObject({
      website: { mainPageSuffix: "index.html", notFoundPage: "404.html" },
      cors: [{ origin: ["https://example.com"], method: ["GET", "HEAD"], responseHeader: ["content-type", "etag"], maxAgeSeconds: 3600 }],
    });
    const stored = gcs.buckets.get("assets")!.files;
    expect([...stored.keys()].sort()).toEqual(["assets/app.js", "index.html"]);
    expect(stored.get("assets/app.js")).toMatchObject({ contentType: "text/javascript; charset=utf-8", cacheControl: "public, max-age=60", body: "x=1" });
    expect(stored.get("assets/app.js")!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.get("index.html")!.cacheControl).toBeUndefined();
    expect(manifestOf(state)).toEqual(["assets/app.js", "index.html"]);
    expect(gcs.calls[0]!.input).toMatchObject({ iamConfiguration: { publicAccessPrevention: "enforced" } });
  });

  test("an index document alone is a website without an error page, CORS or files", async () => {
    const gcs = fakeGcs();
    await applyConfig(configWith({ index_document: "home.html" }), emptyState(), gcs.drivers);
    expect(gcs.calls[0]!.input).toMatchObject({ website: { mainPageSuffix: "home.html" } });
    expect("notFoundPage" in (gcs.calls[0]!.input.website as object)).toBe(false);
    expect("cors" in gcs.calls[0]!.input).toBe(false);
    expect(gcs.calls.filter((c) => c.op === "save")).toEqual([]);
  });

  test("a plain bucket gets no website or CORS", async () => {
    const gcs = fakeGcs();
    await applyConfig(configWith(), emptyState(), gcs.drivers);
    expect("website" in gcs.calls[0]!.input).toBe(false);
    expect("cors" in gcs.calls[0]!.input).toBe(false);
  });

  test("an unchanged site calls nothing", async () => {
    const root = project(FILES);
    const options = siteOptions(root);
    const { state } = await deploy(root, options);
    const again = await deploy(root, options, state, {}, { assets: {} });
    expect(again.gcs.calls).toEqual([]);
    expect(hasChanges(again.actions)).toBe(false);
  });

  test("only new and changed files are uploaded, and removed ones are kept without prune", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root));
    write(root, { "index.html": "<h1>v2</h1>", "about.html": "about", "assets/app.js": null });
    const { gcs, actions } = await deploy(root, siteOptions(root), state, {}, { assets: {} });
    expect(saves(gcs).map((c) => c.input.key).sort()).toEqual(["about.html", "index.html"]);
    expect(gcs.calls.some((c) => c.op === "delete-file")).toBe(false);
    expect(actions[0]!.changes.at(-1)).toBe("site files: 1 new, 1 changed, 1 no longer in the site (kept)");
    expect(manifestOf(state)).toContain("assets/app.js");
  });

  test("prune deletes only the keys cloudgear uploaded", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root, { site_prune: "true" }));
    write(root, { "assets/app.js": null });
    const stranger: StoredFile = { body: "not ours", contentType: "text/plain" };
    const { gcs } = await deploy(root, siteOptions(root, { site_prune: "true" }), state, {}, { assets: { files: new Map([["stranger.txt", stranger]]), objects: 1 } });
    expect(gcs.calls.filter((c) => c.op === "delete-file").map((c) => c.input.key)).toEqual(["assets/app.js"]);
    expect(gcs.buckets.get("assets")!.files.has("stranger.txt")).toBe(true);
    expect(manifestOf(state)).toEqual(["index.html"]);
  });

  test("website and CORS changes patch the bucket; dropping them clears them", async () => {
    const plain = { index_document: "index.html", error_document: "404.html", cors: JSON.stringify(RULES) };
    const next = await (async () => {
      const root = project({});
      const first = await deploy(root, plain);
      const moved = await deploy(root, { ...plain, error_document: "oops.html", cors: JSON.stringify([{ origins: ["*"], methods: ["GET"] }]) }, first.state, {}, { assets: {} });
      return moved.gcs.calls.filter((c) => c.op === "set").map((c) => c.input);
    })();
    expect(next).toEqual([{ website: { mainPageSuffix: "index.html", notFoundPage: "oops.html" }, cors: [{ origin: ["*"], method: ["GET"] }] }]);
    const root = project({});
    const first = await deploy(root, plain);
    const dropped = await deploy(root, {}, first.state, {}, { assets: {} });
    expect(dropped.gcs.calls.filter((c) => c.op === "set").map((c) => c.input)).toEqual([{ website: null, cors: null }]);
  });

  test("the same rules in another key order are not a change", async () => {
    const root = project({});
    const first = await deploy(root, { index_document: "index.html", cors: JSON.stringify(RULES) });
    const reordered = JSON.stringify([{ max_age_seconds: 3600, expose_headers: ["etag"], headers: ["content-type"], methods: ["GET", "HEAD"], origins: ["https://example.com"] }]);
    const again = await deploy(root, { index_document: "index.html", cors: reordered }, first.state, {}, { assets: {} });
    expect(again.gcs.calls).toEqual([]);
  });

  test("a directory that no longer matches the config's hash is refused before any call", async () => {
    const root = project(FILES);
    const options = siteOptions(root);
    write(root, { "index.html": "<h1>edited after generate</h1>" });
    const gcs = fakeGcs({}, { siteRoot: root });
    await expect(apply(plan(configWith(options), emptyState()), emptyState(), gcs.drivers, { save: () => {}, log: () => {} })).rejects.toThrow("re-run `cloudgear generate`");
    expect(gcs.calls).toEqual([]);
    expect(() => withSiteChanges(plan(configWith(options), emptyState()), root)).toThrow("re-run `cloudgear generate`");
  });

  test("a failed upload on create stops the others, removes what landed and the bucket", async () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${String(i).padStart(2, "0")}.txt`, `${i}`]));
    const root = project(many);
    let count = 0;
    const gcs = fakeGcs({}, {
      siteRoot: root,
      failSave: () => (++count === 3 ? new Error("denied") : undefined),
    });
    const config = configWith(siteOptions(root));
    await expect(apply(plan(config, emptyState()), emptyState(), gcs.drivers, { save: () => {}, log: () => {} })).rejects.toThrow("denied");
    expect(count).toBeLessThan(40);
    expect(gcs.buckets.has("assets")).toBe(false);
    expect(gcs.calls.filter((c) => c.op === "delete").map((c) => c.name)).toEqual(["assets"]);
  });

  test("a versioned bucket turns versioning on only after its files are uploaded", async () => {
    const root = project(FILES);
    const { gcs } = await deploy(root, siteOptions(root, { versioning: "true" }));
    expect(gcs.calls[0]!.input).toMatchObject({ versioning: { enabled: false } });
    const order = gcs.calls.map((c) => c.op);
    expect(order.lastIndexOf("save")).toBeLessThan(order.indexOf("set"));
    expect(gcs.calls.find((c) => c.op === "set")!.input).toEqual({ versioning: { enabled: true } });
    expect(gcs.buckets.get("assets")!.versioning).toBe(true);
  });

  test("a failed update records the files it uploaded before failing", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root, { site_prune: "true" }));
    write(root, { "a.html": "a", "b.html": "b" });
    let count = 0;
    const gcs = fakeGcs({ assets: {} }, { siteRoot: root, failSave: () => (++count === 2 ? new Error("denied") : undefined) });
    const actions = withSiteChanges(plan(configWith(siteOptions(root, { site_prune: "true" })), state), root);
    await expect(apply(actions, state, gcs.drivers, { save: () => {}, log: () => {} })).rejects.toThrow("denied");
    expect(manifestOf(state)).toHaveLength(3);
    expect(state.entries[KEY]!.spec.incomplete).toBe(true);
  });

  test("destroying the bucket first deletes the files cloudgear uploaded", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root));
    const gcs = fakeGcs({ assets: { files: new Map([["index.html", { body: "", contentType: "" }], ["assets/app.js", { body: "", contentType: "" }]]), objects: 2 } }, { siteRoot: root });
    await applyConfig(empty(), state, gcs.drivers);
    expect(gcs.calls.filter((c) => c.op === "delete-file").map((c) => c.input.key).sort()).toEqual(["assets/app.js", "index.html"]);
    expect(gcs.buckets.has("assets")).toBe(false);
  });

  test("destroying a versioned bucket with site files fails before deleting anything", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root, { versioning: "true" }));
    const gcs = fakeGcs({ assets: {} }, { siteRoot: root });
    await expect(applyConfig(empty(), state, gcs.drivers)).rejects.toThrow("is versioned and holds site files");
    expect(gcs.calls).toEqual([]);
  });

  test("an imported bucket is never changed, and the import says what was not applied", async () => {
    const root = project(FILES);
    const gcs = fakeGcs({ assets: {} }, { siteRoot: root });
    const state = emptyState();
    const config = configWith(siteOptions(root));
    const result = await adoptEntries(plan(config, state), state, gcs.drivers, () => true);
    expect(result.notes).toEqual([
      "@gcp.GCS assets: its website and CORS settings are not applied: cloudgear never changes an imported bucket",
      "@gcp.GCS assets: its site files are not uploaded: cloudgear never changes an imported bucket",
    ]);
    expect(gcs.calls.map((c) => c.op)).toEqual(["get"]);
    expect(withSiteChanges(plan(config, state), root).map((a) => a.op)).toEqual(["noop"]);
  });

  test("the plan counts new, changed and removed files", async () => {
    const root = project(FILES);
    const actions = withSiteChanges(plan(configWith(siteOptions(root)), emptyState()), root);
    expect(formatPlan(actions)).toContain("(site files: 2 new, 0 changed, 0 no longer in the site (kept))");
  });

  test("dropping only the error document removes the error page from the bucket", async () => {
    const root = project({});
    const first = await deploy(root, { index_document: "index.html", error_document: "404.html" });
    expect(first.gcs.buckets.get("assets")!.metadata.website).toEqual({ mainPageSuffix: "index.html", notFoundPage: "404.html" });
    const gcs = fakeGcs({ assets: { metadata: { website: { mainPageSuffix: "index.html", notFoundPage: "404.html" } } } }, { siteRoot: root });
    await apply(withSiteChanges(plan(configWith({ index_document: "index.html" }), first.state), root), first.state, gcs.drivers, { save: () => {}, log: () => {} });
    expect(gcs.calls.filter((c) => c.op === "set").map((c) => c.input)).toEqual([{ website: { mainPageSuffix: "index.html", notFoundPage: null } }]);
    expect(gcs.buckets.get("assets")!.metadata.website).toEqual({ mainPageSuffix: "index.html" });
  });

  test("dropping only the CORS rules clears them and keeps the website", async () => {
    const root = project({});
    const first = await deploy(root, { index_document: "index.html", cors: JSON.stringify(RULES) });
    const gcs = fakeGcs({ assets: { metadata: { website: { mainPageSuffix: "index.html", notFoundPage: null }, cors: [{}] } } }, { siteRoot: root });
    await apply(withSiteChanges(plan(configWith({ index_document: "index.html" }), first.state), root), first.state, gcs.drivers, { save: () => {}, log: () => {} });
    expect(gcs.calls.filter((c) => c.op === "set").map((c) => c.input)).toEqual([{ cors: null }]);
  });

  test("a headers change that gives the same GCS rule patches nothing", async () => {
    const root = project({});
    const moved = JSON.stringify([{ origins: ["https://example.com"], methods: ["GET", "HEAD"], expose_headers: ["content-type", "etag"], max_age_seconds: 3600 }]);
    const first = await deploy(root, { index_document: "index.html", cors: JSON.stringify(RULES) });
    const again = await deploy(root, { index_document: "index.html", cors: moved }, first.state, {}, { assets: {} });
    expect(again.gcs.calls).toEqual([]);
  });

  test("adding files to an existing plain bucket uploads them without touching the bucket settings", async () => {
    const root = project(FILES);
    const plain = await deploy(root, { index_document: "index.html" });
    expect(plain.state.entries[KEY]!.outputs.site_manifest).toBeUndefined();
    const { gcs, state } = await deploy(root, siteOptions(root, { error_document: "index.html", cors: JSON.stringify(RULES) }), plain.state, {}, { assets: {} });
    expect(saves(gcs)).toHaveLength(2);
    expect(manifestOf(state)).toEqual(["assets/app.js", "index.html"]);
  });

  test("an update that changes only the files patches nothing", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root));
    write(root, { "index.html": "<h1>v2</h1>" });
    const { gcs } = await deploy(root, siteOptions(root), state, {}, { assets: {} });
    expect(gcs.calls.some((c) => c.op === "set")).toBe(false);
    expect(saves(gcs)).toHaveLength(1);
  });

  test("a bucket that is not empty after its files are deleted is reported", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root));
    const stranger: StoredFile = { body: "not ours", contentType: "text/plain" };
    const gcs = fakeGcs({ assets: { files: new Map([["stranger.txt", stranger]]), objects: 1 } }, { siteRoot: root });
    await expect(applyConfig(empty(), state, gcs.drivers)).rejects.toThrow("is not empty");
  });

  test("a failure turning versioning on after the upload removes the files and the bucket", async () => {
    const root = project(FILES);
    const gcs = fakeGcs({}, { siteRoot: root, failSet: (metadata) => ((metadata.versioning as { enabled: boolean } | undefined)?.enabled ? new Error("denied") : undefined) });
    await expect(applyConfig(configWith(siteOptions(root, { versioning: "true" })), emptyState(), gcs.drivers)).rejects.toThrow("denied");
    expect(gcs.buckets.has("assets")).toBe(false);
    expect(gcs.calls.filter((c) => c.op === "delete-file")).toHaveLength(2);
  });

  test("CORS origins other than a full origin or * are refused for GCS but not for S3", () => {
    const rules = (origin: string) => JSON.stringify([{ origins: [origin], methods: ["GET"] }]);
    expect(() => validateOptions("gcp", "@gcp.GCS", { cors: rules("https://*.example.com") }, "bucket")).toThrow('GCS accepts a full origin or "*" alone');
    expect(() => validateOptions("gcp", "@gcp.GCS", { cors: rules("*") }, "bucket")).not.toThrow();
    expect(() => validateOptions("gcp", "@gcp.GCS", { cors: rules("https://a.example.com") }, "bucket")).not.toThrow();
    expect(() => validateOptions("aws", "@aws.S3", { cors: rules("https://*.example.com") }, "bucket")).not.toThrow();
  });

  test("the option rules accept the site settings and reject a bad glob", () => {
    expect(() => validateOptions("gcp", "@gcp.GCS", siteOptions(project(FILES)), "bucket")).not.toThrow();
    expect(() => validateOptions("gcp", "@gcp.GCS", { site_include: "[1]" }, "bucket")).toThrow("non-empty globs");
  });
});
