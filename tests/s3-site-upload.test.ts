import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adoptEntries } from "../src/deploy/adopt";
import { plan, formatPlan, hasChanges } from "../src/deploy/plan";
import { listSiteFiles, siteFilesHash } from "../src/deploy/site-files";
import { withSiteChanges } from "../src/deploy/site-plan";
import { readManifest } from "../src/deploy/aws/s3site";
import type { CloudgearConfig } from "../src/config/schema";
import { apply } from "../src/deploy/apply";
import { baseConfig, emptyState, fakeAws } from "./helpers";

const roots: string[] = [];
function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s3-upload-"));
  roots.push(root);
  write(root, files);
  return root;
}
function write(root: string, files: Record<string, string | null>) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, "dist", name);
    if (content === null) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const cache = [{ match: "assets/**", value: "public, max-age=60" }];

// Options the way `generate` writes them for a site directory.
function siteOptions(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const rules = { include: [], exclude: [], cacheControl: cache };
  const files = listSiteFiles(path.join(root, "dist"), rules, root);
  return {
    index_document: "index.html",
    site_dir: "dist",
    site_cache_control: JSON.stringify(cache),
    site_files_hash: siteFilesHash(files),
    site_files_count: String(files.length),
    ...extra,
  };
}

const configFor = (options: Record<string, string>): CloudgearConfig =>
  baseConfig({ resource: [{ name: "site", type: "@aws.S3", physical_name: "site-bucket", dry: false, source: "a.ts:1", region: "eu-west-1", options }], function: [] });

async function deploy(root: string, options: Record<string, string>, state = emptyState(), overrides: Parameters<typeof fakeAws>[0] = {}) {
  const aws = fakeAws(overrides, undefined, undefined, undefined, root);
  const actions = withSiteChanges(plan(configFor(options), state), root);
  await apply(actions, state, aws.drivers, { save: () => {} });
  return { aws, state, actions };
}

const FILES = { "index.html": "<h1>hi</h1>", "assets/app.js": "x=1" };

describe("uploading site files", () => {
  test("a new bucket gets every file with its type, cache header and sha256", async () => {
    const root = project(FILES);
    const { aws, state } = await deploy(root, siteOptions(root));
    expect(aws.names().filter((n) => /Bucket|Object/.test(n))).toEqual(["CreateBucketCommand", "PutBucketWebsiteCommand", "PutObjectCommand", "PutObjectCommand"]);
    const puts = aws.of("PutObjectCommand").sort((a, b) => (a.Key < b.Key ? -1 : 1));
    expect(puts.map((p) => p.Key)).toEqual(["assets/app.js", "index.html"]);
    expect(puts[0]).toMatchObject({ Bucket: "site-bucket", ContentType: "text/javascript; charset=utf-8", CacheControl: "public, max-age=60" });
    expect(puts[0].Metadata.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(puts[1].CacheControl).toBeUndefined();
    expect(Buffer.from(puts[1].Body).toString()).toBe("<h1>hi</h1>");
    expect(Object.keys(readManifest(state.entries["@aws.S3.site"]!.outputs.site_manifest)).sort()).toEqual(["assets/app.js", "index.html"]);
  });

  test("an unchanged site uploads nothing and plans no change", async () => {
    const root = project(FILES);
    const options = siteOptions(root);
    const { state } = await deploy(root, options);
    const again = await deploy(root, options, state);
    expect(again.aws.calls).toEqual([]);
    expect(hasChanges(again.actions)).toBe(false);
  });

  test("only new and changed files are uploaded, and removed ones are kept without prune", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root));
    write(root, { "index.html": "<h1>v2</h1>", "about.html": "about", "assets/app.js": null });
    const { aws, actions } = await deploy(root, siteOptions(root), state);
    expect(aws.of("PutObjectCommand").map((p) => p.Key).sort()).toEqual(["about.html", "index.html"]);
    expect(aws.names()).not.toContain("DeleteObjectsCommand");
    expect(actions[0]!.changes).toEqual(["spec", "site files: 1 new, 1 changed, 1 no longer in the site (kept)"]);
    expect(Object.keys(readManifest(state.entries["@aws.S3.site"]!.outputs.site_manifest))).toContain("assets/app.js");
  });

  test("prune deletes only the keys cloudgear uploaded", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root, { site_prune: "true" }));
    write(root, { "assets/app.js": null });
    const { aws, actions } = await deploy(root, siteOptions(root, { site_prune: "true" }), state);
    expect(aws.of("DeleteObjectsCommand")).toEqual([{ Bucket: "site-bucket", Delete: { Objects: [{ Key: "assets/app.js" }], Quiet: true } }]);
    expect(aws.names()).not.toContain("PutObjectCommand");
    expect(actions[0]!.changes.at(-1)).toBe("site files: 0 new, 0 changed, 1 removed");
    expect(Object.keys(readManifest(state.entries["@aws.S3.site"]!.outputs.site_manifest))).toEqual(["index.html"]);
  });

  test("a changed header re-uploads a file whose content is the same", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root));
    const next = [{ match: "assets/**", value: "public, max-age=1" }];
    const rules = { include: [], exclude: [], cacheControl: next };
    const options = { ...siteOptions(root), site_cache_control: JSON.stringify(next), site_files_hash: siteFilesHash(listSiteFiles(path.join(root, "dist"), rules, root)) };
    const { aws } = await deploy(root, options, state);
    expect(aws.of("PutObjectCommand")).toMatchObject([{ Key: "assets/app.js", CacheControl: "public, max-age=1" }]);
  });

  test("a directory that no longer matches the config's hash is refused before any call", async () => {
    const root = project(FILES);
    const options = siteOptions(root);
    write(root, { "index.html": "<h1>edited after generate</h1>" });
    const aws = fakeAws({}, undefined, undefined, undefined, root);
    await expect(apply(plan(configFor(options), emptyState()), emptyState(), aws.drivers, { save: () => {} })).rejects.toThrow("changed since the config was generated; re-run `cloudgear generate`");
    expect(aws.calls).toEqual([]);
    expect(() => withSiteChanges(plan(configFor(options), emptyState()), root)).toThrow("re-run `cloudgear generate`");
  });

  test("a failed upload on create stops the others, removes what landed and the bucket", async () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${String(i).padStart(2, "0")}.txt`, `${i}`]));
    const root = project(many);
    const landed: string[] = [];
    let calls = 0;
    const aws = fakeAws(
      {
        PutObjectCommand: async (input) => {
          if (++calls === 3) throw new Error("denied");
          await new Promise((resolve) => setTimeout(resolve, 5));
          landed.push(input.Key);
          return {};
        },
      },
      undefined,
      undefined,
      undefined,
      root,
    );
    await expect(apply(plan(configFor(siteOptions(root)), emptyState()), emptyState(), aws.drivers, { save: () => {} })).rejects.toThrow("denied");
    const deleted = aws.of("DeleteObjectsCommand")[0].Delete.Objects.map((o: { Key: string }) => o.Key).sort();
    expect(deleted).toEqual([...landed].sort());
    expect(calls).toBeLessThan(40);
    expect(aws.names().indexOf("DeleteObjectsCommand")).toBeGreaterThan(aws.names().lastIndexOf("PutObjectCommand"));
    expect(aws.of("DeleteBucketCommand")).toEqual([{ Bucket: "site-bucket" }]);
  });

  test("a failed update records the files it uploaded before failing", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root, { site_prune: "true" }));
    write(root, { "a.html": "a", "b.html": "b" });
    let puts = 0;
    const aws = fakeAws({ PutObjectCommand: () => { if (++puts === 2) throw new Error("denied"); return {}; } }, undefined, undefined, undefined, root);
    const actions = withSiteChanges(plan(configFor(siteOptions(root, { site_prune: "true" })), state), root);
    await expect(apply(actions, state, aws.drivers, { save: () => {} })).rejects.toThrow("denied");
    const manifest = readManifest(state.entries["@aws.S3.site"]!.outputs.site_manifest);
    expect(Object.keys(manifest)).toHaveLength(3);
    expect(state.entries["@aws.S3.site"]!.spec.incomplete).toBe(true);
  });

  test("a prune that S3 refuses for a key is an error and keeps the key tracked", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root, { site_prune: "true" }));
    write(root, { "assets/app.js": null });
    const aws = fakeAws({ DeleteObjectsCommand: () => ({ Errors: [{ Key: "assets/app.js", Message: "AccessDenied" }] }) }, undefined, undefined, undefined, root);
    const actions = withSiteChanges(plan(configFor(siteOptions(root, { site_prune: "true" })), state), root);
    await expect(apply(actions, state, aws.drivers, { save: () => {} })).rejects.toThrow("could not delete assets/app.js: AccessDenied");
    expect(Object.keys(readManifest(state.entries["@aws.S3.site"]!.outputs.site_manifest))).toContain("assets/app.js");
  });

  test("a damaged manifest is an error, not an empty list", async () => {
    expect(() => readManifest("{not json")).toThrow("is damaged");
    expect(() => readManifest('{"a":1}')).toThrow("is damaged");
    expect(() => readManifest("[]")).toThrow("is damaged");
    expect(Object.keys(readManifest(""))).toEqual([]);
  });

  test("destroying a versioned bucket with site files fails before deleting anything", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root, { versioning: "true" }));
    const aws = fakeAws({}, undefined, undefined, undefined, root);
    await expect(apply(plan({ ...configFor({}), resource: [] }, state), state, aws.drivers, { save: () => {} })).rejects.toThrow("is versioned and holds site files");
    expect(aws.calls).toEqual([]);
  });

  test("a new versioned site bucket enables versioning after the files are uploaded", async () => {
    const root = project(FILES);
    const { aws } = await deploy(root, siteOptions(root, { versioning: "true" }));
    expect(aws.names().indexOf("PutBucketVersioningCommand")).toBeGreaterThan(aws.names().lastIndexOf("PutObjectCommand"));
  });

  test("a site directory that is a symbolic link out of the project is refused", async () => {
    const root = project({});
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "s3-outside-"));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "s");
    fs.symlinkSync(outside, path.join(root, "dist"));
    expect(() => listSiteFiles(path.join(root, "dist"), { include: [], exclude: [], cacheControl: [] }, root)).toThrow("resolves outside");
  });

  test("dropping the site deletes tracked files only when pruning", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root, { site_prune: "true" }));
    const { aws, actions } = await deploy(root, { index_document: "index.html", site_prune: "true" }, state);
    expect(aws.of("DeleteObjectsCommand")[0].Delete.Objects).toHaveLength(2);
    expect(actions[0]!.changes.at(-1)).toBe("site files: 0 new, 0 changed, 2 removed");
    expect(state.entries["@aws.S3.site"]!.outputs.site_manifest).toBe("");
  });

  test("destroying the bucket first deletes the files cloudgear uploaded", async () => {
    const root = project(FILES);
    const { state } = await deploy(root, siteOptions(root));
    const aws = fakeAws({}, undefined, undefined, undefined, root);
    await apply(plan({ ...configFor({}), resource: [] }, state), state, aws.drivers, { save: () => {} });
    expect(aws.names()).toEqual(["DeleteObjectsCommand", "DeleteBucketCommand"]);
    expect(aws.of("DeleteObjectsCommand")[0].Delete.Objects.map((o: { Key: string }) => o.Key).sort()).toEqual(["assets/app.js", "index.html"]);
  });

  test("a file named __proto__ is tracked like any other", async () => {
    const root = project({ "index.html": "x" });
    fs.writeFileSync(path.join(root, "dist", "__proto__"), "y");
    const { state } = await deploy(root, siteOptions(root));
    expect(Object.keys(readManifest(state.entries["@aws.S3.site"]!.outputs.site_manifest)).sort()).toEqual(["__proto__", "index.html"]);
  });

  test("the plan counts new, changed and removed files", async () => {
    const root = project(FILES);
    const actions = withSiteChanges(plan(configFor(siteOptions(root)), emptyState()), root);
    expect(formatPlan(actions)).toContain("(site files: 2 new, 0 changed, 0 no longer in the site (kept))");
  });
});

describe("imported site buckets", () => {
  test("are never uploaded to, and the plan leaves them alone", async () => {
    const root = project(FILES);
    const config = configFor(siteOptions(root));
    const aws = fakeAws({ HeadBucketCommand: () => ({}) }, undefined, undefined, undefined, root);
    const state = emptyState();
    const result = await adoptEntries(plan(config, state), state, aws.drivers, () => true);
    expect(result.notes).toContain("@aws.S3 site: its site files are not uploaded: cloudgear never changes an imported bucket");
    expect(aws.names()).toEqual(["HeadBucketCommand"]);
    expect(withSiteChanges(plan(config, state), root).map((a) => a.op)).toEqual(["noop"]);
  });
});
