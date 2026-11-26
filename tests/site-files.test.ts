import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentTypeOf, listSiteFiles, MAX_SITE_FILES, siteFilesHash } from "../src/deploy/site-files";

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-files-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const none = { include: [], exclude: [], cacheControl: [] };

describe("listSiteFiles", () => {
  test("lists files by key with hashes, types and headers", () => {
    const dir = tree({ "index.html": "<h1>hi</h1>", "assets/app.js": "x=1", "assets/app.js.map": "{}" });
    const files = listSiteFiles(dir, { include: [], exclude: ["**/*.map"], cacheControl: [{ match: "assets/**", value: "public, max-age=60" }] });
    expect(files.map((f) => f.key)).toEqual(["assets/app.js", "index.html"]);
    expect(files[0]).toMatchObject({ size: 3, cacheControl: "public, max-age=60" });
    expect(files[0]?.contentType).toContain("javascript");
    expect(files[1]?.contentType).toContain("text/html");
    expect(files[1]?.cacheControl).toBeUndefined();
    expect(files[1]?.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(files[1]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("include narrows the set and exclude removes from it", () => {
    const dir = tree({ "a.html": "1", "b.css": "2", "c/d.html": "3" });
    expect(listSiteFiles(dir, { ...none, include: ["**/*.html"] }).map((f) => f.key)).toEqual(["a.html", "c/d.html"]);
    expect(listSiteFiles(dir, { ...none, include: ["**/*.html"], exclude: ["c/**"] }).map((f) => f.key)).toEqual(["a.html"]);
  });

  test("the first matching cache rule wins", () => {
    const dir = tree({ "assets/a.js": "1" });
    const [file] = listSiteFiles(dir, { ...none, cacheControl: [{ match: "assets/**", value: "first" }, { match: "**", value: "second" }] });
    expect(file?.cacheControl).toBe("first");
  });

  test("rejects a missing directory, a file and symbolic links", () => {
    expect(() => listSiteFiles("/nonexistent/site-dir", none)).toThrow("does not exist; build the site first");
    const dir = tree({ "a.txt": "1" });
    expect(() => listSiteFiles(path.join(dir, "a.txt"), none)).toThrow("does not exist");
    fs.symlinkSync(path.join(dir, "a.txt"), path.join(dir, "link.txt"));
    expect(() => listSiteFiles(dir, none)).toThrow("is a symbolic link");
  });
});

describe("walking", () => {
  test("a symbolic link inside an excluded tree is skipped, one that would be uploaded is an error", () => {
    const dir = tree({ "index.html": "1", "node_modules/pkg/a.js": "2", "other/b.js": "3" });
    fs.symlinkSync(path.join(dir, "index.html"), path.join(dir, "node_modules", "link.js"));
    expect(listSiteFiles(dir, { ...none, exclude: ["node_modules/**"] }).map((f) => f.key)).toEqual(["index.html", "other/b.js"]);
    expect(listSiteFiles(dir, { ...none, include: ["index.html"] }).map((f) => f.key)).toEqual(["index.html"]);
    expect(() => listSiteFiles(dir, none)).toThrow("is a symbolic link");
    fs.symlinkSync(path.join(dir, "other"), path.join(dir, "linked-dir"));
    expect(listSiteFiles(dir, { ...none, exclude: ["node_modules/**", "linked-dir/**"] }).map((f) => f.key)).toEqual(["index.html", "other/b.js"]);
  });

  test("excluded files do not count toward the limit", () => {
    const dir = tree({ "keep.txt": "1" });
    fs.mkdirSync(path.join(dir, "skip"));
    for (let i = 0; i <= MAX_SITE_FILES; i++) fs.writeFileSync(path.join(dir, "skip", `f${i}`), "");
    expect(listSiteFiles(dir, { ...none, exclude: ["skip/**"] }).map((f) => f.key)).toEqual(["keep.txt"]);
    expect(() => listSiteFiles(dir, none)).toThrow(`more than ${MAX_SITE_FILES} files`);
  });
});

describe("contentTypeOf", () => {
  test("is fixed by a table, not by the runtime", () => {
    expect(contentTypeOf("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeOf("a/app.JS")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeOf("logo.svg")).toBe("image/svg+xml");
    expect(contentTypeOf("font.woff2")).toBe("font/woff2");
    expect(contentTypeOf("data.unknownext")).toBe("application/octet-stream");
    expect(contentTypeOf("README")).toBe("application/octet-stream");
  });
});

describe("siteFilesHash", () => {
  test("changes with content, names, types and headers, not with order of calls", () => {
    const one = tree({ "a.html": "1", "b.html": "2" });
    const base = siteFilesHash(listSiteFiles(one, none));
    expect(siteFilesHash(listSiteFiles(one, none))).toBe(base);
    fs.writeFileSync(path.join(one, "b.html"), "3");
    expect(siteFilesHash(listSiteFiles(one, none))).not.toBe(base);
    const two = tree({ "a.html": "1", "c.html": "2" });
    expect(siteFilesHash(listSiteFiles(two, none))).not.toBe(base);
    const same = tree({ "a.html": "1", "b.html": "2" });
    expect(siteFilesHash(listSiteFiles(same, none))).toBe(base);
    expect(siteFilesHash(listSiteFiles(same, { ...none, cacheControl: [{ match: "**", value: "x" }] }))).not.toBe(base);
  });
});
