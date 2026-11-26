import { describe, expect, test } from "bun:test";
import { adoptEntries } from "../src/deploy/adopt";
import { plan } from "../src/deploy/plan";
import { PROVIDERS } from "../src/providers";
import type { CloudgearConfig } from "../src/config/schema";
import { applyAll, baseConfig, emptyState, fakeAws } from "./helpers";

const RULES = [{ origins: ["https://example.com"], methods: ["GET", "HEAD"], headers: ["content-type"], expose_headers: ["etag"], max_age_seconds: 3600 }];

const withOptions = (options: Record<string, string> | undefined, region = "eu-west-1"): CloudgearConfig =>
  baseConfig({ resource: [{ name: "site", type: "@aws.S3", physical_name: "site-bucket", dry: false, source: "a.ts:1", region, ...(options ? { options } : {}) }], function: [] });

const siteOptions = (more: Record<string, string> = {}) => ({ index_document: "index.html", error_document: "404.html", cors: JSON.stringify(RULES), ...more });

describe("creating a website bucket", () => {
  test("sets the website and CORS configuration after creating the bucket", async () => {
    const aws = await applyAll(withOptions(siteOptions()), emptyState());
    expect(aws.names().filter((n) => /Bucket/.test(n))).toEqual(["CreateBucketCommand", "PutBucketWebsiteCommand", "PutBucketCorsCommand"]);
    expect(aws.of("PutBucketWebsiteCommand")).toEqual([{ Bucket: "site-bucket", WebsiteConfiguration: { IndexDocument: { Suffix: "index.html" }, ErrorDocument: { Key: "404.html" } } }]);
    expect(aws.of("PutBucketCorsCommand")).toEqual([
      {
        Bucket: "site-bucket",
        CORSConfiguration: { CORSRules: [{ AllowedOrigins: ["https://example.com"], AllowedMethods: ["GET", "HEAD"], AllowedHeaders: ["content-type"], ExposeHeaders: ["etag"], MaxAgeSeconds: 3600 }] },
      },
    ]);
  });

  test("a plain bucket gets neither", async () => {
    const aws = await applyAll(withOptions(undefined), emptyState());
    expect(aws.names()).not.toContain("PutBucketWebsiteCommand");
    expect(aws.names()).not.toContain("PutBucketCorsCommand");
  });

  test("an index document alone is a website without an error page or CORS", async () => {
    const aws = await applyAll(withOptions({ index_document: "home.html" }), emptyState());
    expect(aws.of("PutBucketWebsiteCommand")).toEqual([{ Bucket: "site-bucket", WebsiteConfiguration: { IndexDocument: { Suffix: "home.html" } } }]);
    expect(aws.names()).not.toContain("PutBucketCorsCommand");
  });

  test("a failure while configuring deletes the bucket it just created", async () => {
    const aws = fakeAws({
      PutBucketCorsCommand: () => {
        throw new Error("denied");
      },
    });
    await expect(applyAll(withOptions(siteOptions()), emptyState(), aws)).rejects.toThrow("denied");
    expect(aws.of("DeleteBucketCommand")).toEqual([{ Bucket: "site-bucket" }]);
  });

  test("site files are refused before anything is created", async () => {
    const aws = fakeAws();
    await expect(applyAll(withOptions(siteOptions({ site_dir: "dist", site_files_hash: "a".repeat(64), site_files_count: "3" })), emptyState(), aws)).rejects.toThrow(
      "uploading site files (dist) is not supported by apply yet",
    );
    expect(aws.names()).not.toContain("CreateBucketCommand");
  });
});

describe("changing a website bucket", () => {
  const apply2 = async (before: Record<string, string> | undefined, after: Record<string, string> | undefined) => {
    const state = emptyState();
    await applyAll(withOptions(before), state);
    const aws = fakeAws();
    await applyAll(withOptions(after), state, aws);
    return aws;
  };

  test("an unchanged setup calls nothing", async () => {
    const aws = await apply2(siteOptions(), siteOptions());
    expect(aws.calls).toEqual([]);
  });

  test("a new CORS rule replaces the rules and leaves the website alone", async () => {
    const aws = await apply2(siteOptions(), siteOptions({ cors: JSON.stringify([{ origins: ["*"], methods: ["GET"] }]) }));
    expect(aws.names()).toEqual(["PutBucketCorsCommand"]);
    expect(aws.of("PutBucketCorsCommand")[0].CORSConfiguration.CORSRules).toEqual([{ AllowedOrigins: ["*"], AllowedMethods: ["GET"] }]);
  });

  test("a new error document updates the website only", async () => {
    const aws = await apply2(siteOptions(), siteOptions({ error_document: "oops.html" }));
    expect(aws.names()).toEqual(["PutBucketWebsiteCommand"]);
  });

  test("dropping CORS deletes it, dropping the website deletes it", async () => {
    const noCors = await apply2(siteOptions(), { index_document: "index.html", error_document: "404.html" });
    expect(noCors.names()).toEqual(["DeleteBucketCorsCommand"]);
    const plain = await apply2(siteOptions(), undefined);
    expect(plain.names().sort()).toEqual(["DeleteBucketCorsCommand", "DeleteBucketWebsiteCommand"]);
  });

  test("adding a website to a plain bucket configures it", async () => {
    const aws = await apply2(undefined, siteOptions());
    expect(aws.names().sort()).toEqual(["PutBucketCorsCommand", "PutBucketWebsiteCommand"]);
  });

  test("site files are refused on update too", async () => {
    const state = emptyState();
    await applyAll(withOptions(siteOptions()), state);
    await expect(applyAll(withOptions(siteOptions({ site_dir: "dist" })), state)).rejects.toThrow("uploading site files");
  });
});

describe("importing a website bucket", () => {
  const importing = async (config: CloudgearConfig) => {
    const aws = fakeAws({ HeadBucketCommand: () => ({}) });
    const state = emptyState();
    const result = await adoptEntries(plan(config, state), state, aws.drivers, () => true);
    return { aws, state, result };
  };

  test("is recorded as imported, with a note that its settings are not applied", async () => {
    const { aws, state, result } = await importing(withOptions(siteOptions()));
    expect(result.adopted).toHaveLength(1);
    expect(result.notes).toEqual(["@aws.S3 site: its website and CORS settings are not applied: cloudgear never changes an imported bucket"]);
    expect(state.entries["@aws.S3.site"]).toMatchObject({ imported: true, spec: { physical_name: "site-bucket" } });
    expect(aws.names()).toEqual(["HeadBucketCommand"]);
  });

  test("a plain bucket gets no note", async () => {
    const { result } = await importing(withOptions(undefined));
    expect(result.notes).toEqual([]);
  });

  test("site files are refused", async () => {
    const { result } = await importing(withOptions(siteOptions({ site_dir: "dist" })));
    expect(result.adopted).toEqual([]);
    expect(result.failed[0]).toContain("uploading site files");
  });
});

describe("option rules for website buckets", () => {
  const keys = PROVIDERS.aws!.options["@aws.S3"]!.keys;

  test("accept what generate writes", () => {
    expect(keys.index_document!("index.html")).toBeUndefined();
    expect(keys.error_document!("errors/404.html")).toBeUndefined();
    expect(keys.cors!(JSON.stringify(RULES))).toBeUndefined();
    expect(keys.site_dir!("../dist")).toBeUndefined();
    expect(keys.site_include!(JSON.stringify(["**/*.html"]))).toBeUndefined();
    expect(keys.site_exclude!(JSON.stringify(["**/*.map"]))).toBeUndefined();
    expect(keys.site_cache_control!(JSON.stringify([{ match: "a/**", value: "public, max-age=1" }]))).toBeUndefined();
    expect(keys.site_prune!("true")).toBeUndefined();
    expect(keys.site_files_hash!("a".repeat(64))).toBeUndefined();
    expect(keys.site_files_count!("12")).toBeUndefined();
  });

  test("reject what apply could not use", () => {
    expect(keys.index_document!("a/b")).toContain('without "/"');
    expect(keys.error_document!("/x")).toContain("does not start");
    expect(keys.cors!("not json")).toBe("must be JSON");
    expect(keys.cors!("{}")).toContain("list of CORS rules");
    expect(keys.cors!(JSON.stringify([{ origins: [], methods: ["GET"] }]))).toContain("origins must not be empty");
    expect(keys.cors!(JSON.stringify([{ origins: ["*"], methods: ["PATCH"] }]))).toContain('method "PATCH"');
    expect(keys.site_include!("[1]")).toContain("non-empty globs");
    expect(keys.site_cache_control!(JSON.stringify([{ match: "x" }]))).toContain("value");
    expect(keys.site_prune!("false")).toContain("one of true");
    expect(keys.site_files_hash!("xyz")).toContain("SHA-256");
    expect(keys.site_files_count!("-1")).toContain("integer");
  });
});
