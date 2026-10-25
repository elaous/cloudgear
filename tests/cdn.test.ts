import { describe, expect, test, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BlobStore } from "@cloudgear/blob";
import { CDN, Cert } from "@cloudgear/cdn";
import { DNS } from "@cloudgear/dns";
import { FunctionRouter } from "@cloudgear/functions";
import { decodeConfig } from "../src/config/schema";
import { generate } from "../src/generate";

// Analyzing an app and bundling functions take seconds when the machine is busy.
setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", name);
const site = () => new BlobStore("aws", "://my-site");

describe("Cert and CDN", () => {
  test("take their domain from the DNS and expose the site URL", () => {
    const dns = new DNS("gandi", "cdn.example.com");
    const cert = new Cert("aws", dns);
    const cdn = new CDN("aws", dns, { cert, bucket: site() });
    expect(cert.domain).toBe("cdn.example.com");
    expect(cdn.domain).toBe("cdn.example.com");
    expect(cdn.url).toBe("https://cdn.example.com");
  });

  test("reject a certificate for another domain, another provider and a foreign bucket", () => {
    const dns = new DNS("gandi", "cdn.example.com");
    const other = new DNS("gandi", "www.example.com");
    expect(() => new CDN("aws", dns, { cert: new Cert("aws", other), bucket: site() })).toThrow(/certificate covers "www.example.com" but the CDN serves "cdn.example.com"/);
    expect(() => new Cert("gcp" as "aws", dns)).toThrow(/not supported yet/);
    expect(() => new CDN("aws", dns, { cert: new Cert("aws", dns), bucket: new BlobStore("gcp", "://b") })).toThrow(/bucket uses "gcp"/);
  });
});

describe("FunctionRouter cdn option", () => {
  const dns = new DNS("gandi", "cdn.example.com");
  const cdn = new CDN("aws", dns, { cert: new Cert("aws", dns), bucket: site() });
  const echo = (input: unknown) => input;

  test("urls() are the CDN's once deployed, with path params left as placeholders", () => {
    const router = new FunctionRouter("aws", {
      cdn,
      endpoints: { "GET /objects/{param}": "https://abc.lambda-url.us-east-1.on.aws/" },
    }).url("GET", "/objects/{param}", echo, { name: "getObjects" });
    expect(router.urls()).toEqual({ getObjects: "https://cdn.example.com/objects/{param}" });
  });

  test("locally, urls() are still the local server's", () => {
    const router = new FunctionRouter("aws", { cdn, mode: "local" }).url("GET", "/x", echo, { name: "x" });
    router.listen(0);
    try {
      expect(router.urls().x).toMatch(/^http:\/\/localhost:\d+\/x$/);
    } finally {
      router.stop();
    }
  });
});

describe("generate with a CDN", () => {
  test("writes dns, certificate and cdn into the config, and it round-trips", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-cdn-"));
    try {
      const configPath = path.join(dir, "cloudgear.prototxt");
      const { config } = await generate({ entry: fixture("cdn/app.ts"), configPath, buildDir: path.join(dir, "build"), project: "edge" });

      expect(config.dns).toEqual({ provider: "gandi", domain: "cdn.example.com", zone: "example.com" });
      expect(config.certificate).toEqual({ domain: "cdn.example.com" });
      expect(config.cdn).toEqual({
        provider: "aws",
        domain: "cdn.example.com",
        bucket: "my-site",
        path: "web/",
        behavior: [
          { path_pattern: "/health", function: "health", method: ["GET"] },
          { path_pattern: "/users/*/profile", function: "nested", method: ["GET"] },
          { path_pattern: "/objects/*", function: "getObject", method: ["GET", "HEAD", "PUT"] },
        ],
      });

      const text = fs.readFileSync(configPath, "utf8");
      expect(text).toContain('domain: "cdn.example.com"');
      expect(text).toContain('path_pattern: "/objects/*"');
      expect(decodeConfig(text)).toEqual(config);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("functions trust router-supplied identity unless a CDN lets viewers reach them directly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-trust-"));
    try {
      const entryOf = (build: string, name: string) => fs.readFileSync(path.join(dir, build, name, "entry.ts"), "utf8");
      await generate({ entry: fixture("cdn/app.ts"), configPath: path.join(dir, "a.prototxt"), buildDir: path.join(dir, "cdn-build") });
      expect(entryOf("cdn-build", "health")).toContain("trustContext: false");

      await generate({ entry: fixture("cdn/bucket-only.ts"), configPath: path.join(dir, "b.prototxt"), buildDir: path.join(dir, "site-build") });
      expect(entryOf("site-build", "f")).toContain("trustContext: true");

      await generate({
        entry: path.join(import.meta.dir, "..", "examples", "router-app", "main.ts"),
        configPath: path.join(dir, "c.prototxt"),
        buildDir: path.join(dir, "plain-build"),
      });
      expect(entryOf("plain-build", "health")).toContain("trustContext: true");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an app without edge declarations has none in its config", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-noedge-"));
    try {
      const { config } = await generate({
        entry: path.join(import.meta.dir, "..", "examples", "router-app", "main.ts"),
        configPath: path.join(dir, "cloudgear.prototxt"),
        buildDir: path.join(dir, "build"),
      });
      expect(config.dns).toBeUndefined();
      expect(config.cdn).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
