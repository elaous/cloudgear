import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeApp } from "../src/analyze/app";
import { decodeConfig } from "../src/config/schema";
import { listSiteFiles, siteFilesHash } from "../src/deploy/site-files";
import { generate } from "../src/generate";
import { validateConfigOptions } from "../src/providers";

setDefaultTimeout(30_000);

const site = (name: string) => path.join(import.meta.dir, "fixtures", "router", "site", name);
const dist = site("dist");
const env = { ENV_DOMAIN: "example.com" };

describe("BlobStoreWebSite in setup.ts", () => {
  test("its settings become options on the bucket resource", () => {
    const [resource] = analyzeApp(site("ok.ts"), env).resources;
    expect(resource).toMatchObject({ name: "web.example.com", provider: "aws", siteDir: dist });
    const options = resource!.options!;
    expect(options.index_document).toBe("index.html");
    expect(options.error_document).toBe("404.html");
    expect(JSON.parse(options.cors!)).toEqual([{ origins: ["https://web.example.com"], methods: ["GET", "HEAD"], max_age_seconds: 3600 }]);
    expect(options.site_exclude).toBe('["**/*.map"]');
    expect(options.site_prune).toBe("true");
    expect(JSON.parse(options.site_cache_control!)).toEqual([{ match: "assets/**", value: "public, max-age=31536000, immutable" }]);
    expect(options.site_files_count).toBe("3");
    const files = listSiteFiles(dist, { include: [], exclude: ["**/*.map"], cacheControl: [{ match: "assets/**", value: "public, max-age=31536000, immutable" }] });
    expect(options.site_files_hash).toBe(siteFilesHash(files));
    expect(options.site_include).toBeUndefined();
  });

  test("a gcp site becomes a @gcp.GCS bucket with the same options", () => {
    const [resource] = analyzeApp(site("gcp.ts")).resources;
    expect(resource).toMatchObject({ name: "gcs-site", provider: "gcp", siteDir: dist });
    expect(resource!.options).toMatchObject({ location: "us-central1", index_document: "index.html", error_document: "404.html", site_exclude: '["**/*.map"]', site_files_count: "3" });
    expect(JSON.parse(resource!.options!.cors!)).toEqual([{ origins: ["https://gcs.example.com"], methods: ["GET"], headers: ["content-type"], expose_headers: ["etag"] }]);
  });

  test("a site with no settings still gets the default index document", () => {
    const [resource] = analyzeApp(site("minimal.ts")).resources;
    expect(resource!.options).toEqual({ index_document: "index.html" });
    expect(resource!.siteDir).toBeUndefined();
  });

  test("the domain follows the environment", () => {
    const [resource] = analyzeApp(site("ok.ts"), { ENV_DOMAIN: "staging.test" }).resources;
    expect(resource!.name).toBe("web.staging.test");
    expect(JSON.parse(resource!.options!.cors!)[0].origins).toEqual(["https://web.staging.test"]);
  });

  test("an unset environment variable is named", () => {
    expect(() => analyzeApp(site("ok.ts"), {})).toThrow(/ENV_DOMAIN is unset or empty/);
  });

  test("mistakes are reported where they are", () => {
    const cases: Record<string, RegExp> = {
      "bad-provider.ts": /BlobStoreWebSite supports providers "aws" and "gcp" for now/,
      "bad-missing-dir.ts": /site directory .*missing does not exist; build the site first/,
      "bad-empty.ts": /files: \.\/dist holds no files after include and exclude/,
      "bad-key.ts": /unknown BlobStoreWebSite option "corss"/,
      "bad-prune.ts": /prune must be true or false/,
      "bad-cors.ts": /method "FETCH" must be one of GET, HEAD, POST, PUT, DELETE/,
      "bad-cors-key.ts": /unknown cors rule option "extra"/,
      "bad-clash.ts": /options\.cors is set by the web site settings/,
      "bad-index.ts": /indexDocument must be a file name without "\/"/,
      "bad-outside.ts": /is outside the project/,
      "bad-glob.ts": /files\.exclude "\.\/index\.html" must not start with/,
    };
    for (const [file, message] of Object.entries(cases)) {
      expect(() => analyzeApp(site(file), env), file).toThrow(message);
    }
  });
});

describe("generate for a website bucket", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-site-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("writes the options, with the directory relative to the config", async () => {
    const configPath = path.join(dir, "out", "cloudgear.prototxt");
    await generate({ entry: site("ok.ts"), configPath, buildDir: path.join(dir, "build"), project: "demo", setupEnv: env });
    const config = decodeConfig(fs.readFileSync(configPath, "utf8"));
    const bucket = config.resource.find((r) => r.type === "@aws.S3")!;
    expect(bucket.physical_name).toBe("web.example.com");
    expect(bucket.options?.site_dir).toBe(path.relative(path.dirname(configPath), dist));
    expect(bucket.options?.index_document).toBe("index.html");
    expect(bucket.options?.site_files_count).toBe("3");
  });

  test("validation rejects a website option that apply could not use", async () => {
    const configPath = path.join(dir, "bad", "cloudgear.prototxt");
    await generate({ entry: site("ok.ts"), configPath, buildDir: path.join(dir, "build2"), project: "demo", setupEnv: env });
    const config = decodeConfig(fs.readFileSync(configPath, "utf8"));
    const bucket = config.resource.find((r) => r.type === "@aws.S3")!;
    expect(() => validateConfigOptions(config)).not.toThrow();
    bucket.options = { ...bucket.options!, index_document: "a/b" };
    expect(() => validateConfigOptions(config)).toThrow(/index_document/);
    bucket.options = { ...bucket.options, index_document: "index.html", site_prune: "false" };
    expect(() => validateConfigOptions(config)).toThrow(/site_prune/);
  });
});
