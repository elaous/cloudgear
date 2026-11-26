import { describe, expect, test } from "bun:test";
import { BlobStoreWebSite, type BlobStoreWebSiteOptions } from "@cloudgear/blob";

const site = (options: BlobStoreWebSiteOptions = {}) => new BlobStoreWebSite("aws", "s3://web.example.com", options);

describe("BlobStoreWebSite", () => {
  test("is a BlobStore with a default index document", () => {
    const store = site({ path: "app" });
    expect(store.name).toBe("web.example.com");
    expect(store.path).toBe("app/");
    expect(store.indexDocument).toBe("index.html");
    expect(store.errorDocument).toBeUndefined();
    expect(store.files).toBeUndefined();
    expect(store.cors).toEqual([]);
  });

  test("keeps its documents, files and CORS rules", () => {
    const store = site({
      indexDocument: "home.html",
      errorDocument: "errors/404.html",
      files: { dir: "./dist", include: ["**/*.html"], exclude: ["**/*.map"], prune: true, cacheControl: [{ match: "assets/**", value: "public, max-age=60" }] },
      cors: [{ origins: ["https://example.com", "*"], methods: ["GET", "HEAD"], headers: ["content-type"], exposeHeaders: ["etag"], maxAgeSeconds: 3600 }],
    });
    expect(store.indexDocument).toBe("home.html");
    expect(store.errorDocument).toBe("errors/404.html");
    expect(store.files?.prune).toBe(true);
    expect(store.cors[0]?.maxAgeSeconds).toBe(3600);
  });

  test("rejects bad documents", () => {
    expect(() => site({ indexDocument: "a/b.html" })).toThrow('indexDocument must be a file name without "/"');
    expect(() => site({ indexDocument: "" })).toThrow("indexDocument");
    expect(() => site({ errorDocument: "/404.html" })).toThrow("errorDocument must be a key that does not start with");
  });

  test("rejects bad CORS rules", () => {
    const rule = { origins: ["https://example.com"], methods: ["GET" as const] };
    expect(() => site({ cors: [] })).toThrow("cors takes 1 to 100 rules");
    expect(() => site({ cors: [{ ...rule, origins: [] }] })).toThrow("origins must not be empty");
    expect(() => site({ cors: [{ ...rule, origins: ["example.com"] }] })).toThrow('origin "example.com" must be "*"');
    expect(() => site({ cors: [{ ...rule, origins: ["https://*.example.*"] }] })).toThrow("at most one");
    expect(() => site({ cors: [{ ...rule, methods: [] }] })).toThrow("methods must not be empty");
    expect(() => site({ cors: [{ ...rule, methods: ["GET", "GET"] }] })).toThrow("lists a method twice");
    expect(() => site({ cors: [{ ...rule, methods: ["FETCH" as never] }] })).toThrow('method "FETCH" must be one of GET, HEAD, POST, PUT, DELETE');
    expect(() => site({ cors: [{ ...rule, headers: [""] }] })).toThrow("headers must be a list of non-empty strings");
    expect(() => site({ cors: [{ ...rule, maxAgeSeconds: -1 }] })).toThrow("maxAgeSeconds must be an integer");
    expect(() => site({ cors: [{ ...rule, maxAgeSeconds: 1.5 }] })).toThrow("maxAgeSeconds must be an integer");
    expect(site({ cors: [{ ...rule, origins: ["https://*.example.com", "http://localhost:3000"] }] }).cors).toHaveLength(1);
  });

  test("rejects origins without a host and globs that can never match", () => {
    const rule = { origins: ["https://example.com"], methods: ["GET" as const] };
    expect(() => site({ cors: [{ ...rule, origins: ["https://"] }] })).toThrow('origin "https://"');
    expect(() => site({ cors: [{ ...rule, origins: ["https://*"] }] })).toThrow('origin "https://*"');
    for (const bad of ["./index.html", "/index.html", "!*.map"]) {
      expect(() => site({ files: { dir: "./d", exclude: [bad] } })).toThrow(`files.exclude "${bad}" must not start with`);
      expect(() => site({ files: { dir: "./d", include: [bad] } })).toThrow("files.include");
      expect(() => site({ files: { dir: "./d", cacheControl: [{ match: bad, value: "x" }] } })).toThrow("cacheControl[0].match");
    }
    expect(site({ files: { dir: "./d", include: ["**/*.html"], exclude: ["assets/**"], cacheControl: [{ match: "**", value: "x" }] } }).files?.dir).toBe("./d");
  });

  test("rejects bad file settings", () => {
    expect(() => site({ files: { dir: "" } })).toThrow("files.dir must be a non-empty string");
    expect(() => site({ files: { dir: "./d", include: [""] } })).toThrow("files.include");
    expect(() => site({ files: { dir: "./d", cacheControl: [{ match: "", value: "x" }] } })).toThrow("cacheControl[0].match");
    expect(() => site({ files: { dir: "./d", cacheControl: [{ match: "*", value: "a\nb" }] } })).toThrow("one-line header value");
  });

  test("keeps the BlobStore rules for the bucket name and provider", () => {
    expect(() => new BlobStoreWebSite("aws", "s3://UPPER_case")).toThrow();
    expect(() => new BlobStoreWebSite("gcp", "s3://bucket")).toThrow();
  });
});
