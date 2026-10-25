import { describe, expect, test, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BlobStore } from "@cloudgear/blob";
import { CDN, Cert, registerCdnDriver, registerCertDriver, type CdnDriver, type CertDriver } from "@cloudgear/cdn";
import { CloudFrontCdnDriver } from "../packages/cdn/drivers/cloudfront";
import { MemoryCdnDriver } from "../packages/cdn/drivers/memory-cdn";
import { AcmCertDriver } from "../packages/cdn/drivers/acm";
import { MemoryCertDriver } from "../packages/cdn/drivers/memory";
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
    expect(cdn.domain).toBe("cdn.example.com");
  });

  test("reject a certificate for another domain, another provider and a foreign bucket", () => {
    const dns = new DNS("gandi", "cdn.example.com");
    const other = new DNS("gandi", "www.example.com");
    expect(() => new CDN("aws", dns, { cert: new Cert("aws", other), bucket: site() })).toThrow(/certificate covers "www.example.com" but the CDN serves "cdn.example.com"/);
    expect(() => new Cert("gcp" as "aws", dns)).toThrow(/not supported yet/);
    expect(() => new CDN("aws", dns, { cert: new Cert("aws", dns), bucket: new BlobStore("gcp", "://b") })).toThrow(/bucket uses "gcp"/);
  });
});

describe("Cert drivers", () => {
  const dns = new DNS("aws", "cdn.example.com");

  test("status goes through the driver, which can be injected", async () => {
    const driver = new MemoryCertDriver(new Map());
    const cert = new Cert("aws", dns, { driver });
    expect(await cert.status()).toEqual({ state: "none" });
    driver.set("cdn.example.com", { state: "issued", id: "arn:1" });
    expect(await cert.status()).toEqual({ state: "issued", id: "arn:1" });
  });

  test("CLOUDGEAR_CERT_DRIVER=memory and registered drivers replace the built-in one", async () => {
    process.env.CLOUDGEAR_CERT_DRIVER = "memory";
    try {
      expect(await new Cert("aws", dns).status()).toEqual({ state: "none" });
    } finally {
      delete process.env.CLOUDGEAR_CERT_DRIVER;
    }
    const custom: CertDriver = { describe: async (domain) => ({ state: "pending", id: domain }) };
    registerCertDriver("aws", () => custom);
    try {
      expect(await new Cert("aws", dns).status()).toEqual({ state: "pending", id: "cdn.example.com" });
    } finally {
      registerCertDriver("aws", (await import("../packages/cdn/drivers/acm")).createAcmDriver);
    }
  });

  test("the ACM driver picks the newest certificate for exactly that domain", async () => {
    const sent: unknown[] = [];
    const client = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push([command.constructor.name, command.input]);
        if (command.constructor.name === "ListCertificatesCommand") {
          return command.input.NextToken
            ? { CertificateSummaryList: [{ DomainName: "cdn.example.com", CertificateArn: "arn:new", CreatedAt: new Date(2000) }] }
            : {
                NextToken: "t",
                CertificateSummaryList: [
                  { DomainName: "cdn.example.com", CertificateArn: "arn:old", CreatedAt: new Date(1000) },
                  { DomainName: "other.example.com", CertificateArn: "arn:other", CreatedAt: new Date(3000) },
                ],
              };
        }
        return { Certificate: { Status: "PENDING_VALIDATION" } };
      },
    };
    const driver = new AcmCertDriver(client as never);
    expect(await driver.describe("cdn.example.com")).toEqual({ state: "pending", id: "arn:new" });
    expect(sent.at(-1)).toEqual(["DescribeCertificateCommand", { CertificateArn: "arn:new" }]);
    expect(await new AcmCertDriver({ send: async () => ({}) } as never).describe("x.example.com")).toEqual({ state: "none" });
  });
});

describe("CDN status() and url()", () => {
  const dns = new DNS("gandi", "cdn.example.com");
  const make = (driver: CdnDriver) => new CDN("aws", dns, { cert: new Cert("aws", dns), bucket: site(), driver });
  const inDir = async <T>(files: Record<string, unknown>, run: () => Promise<T>): Promise<T> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-url-"));
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.mkdirSync(path.join(dir, ".cloudgear"));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, ".cloudgear", name), JSON.stringify(content));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      return await run();
    } finally {
      process.chdir(cwd);
    }
  };

  test("status() and url() come from the driver when nothing was written by apply", async () => {
    const driver = new MemoryCdnDriver(new Map());
    const cdn = make(driver);
    expect(await cdn.status()).toEqual({ state: "none" });
    await expect(cdn.url()).rejects.toThrow(/is not deployed; run cloudgear apply/);
    driver.set("cdn.example.com", { state: "deploying", id: "E1", url: "https://d111.cloudfront.net" });
    expect(await cdn.status()).toEqual({ state: "deploying", id: "E1", url: "https://d111.cloudfront.net" });
    expect(await cdn.url()).toBe("https://d111.cloudfront.net");
  });

  test("url() prefers the endpoints file for this domain and never calls the driver", async () => {
    const driver: CdnDriver = { describe: async () => Promise.reject(new Error("no calls expected")) };
    const cdn = make(driver);
    const written = { provider: "aws", routes: {}, cdn: { domain: "cdn.example.com", url: "https://d222.cloudfront.net" } };
    expect(await inDir({ "endpoints.json": written }, () => cdn.url())).toBe("https://d222.cloudfront.net");
    const other = { ...written, cdn: { domain: "www.example.com", url: "https://d333.cloudfront.net" } };
    await expect(inDir({ "endpoints.json": other }, () => cdn.url())).rejects.toThrow("no calls expected");
    await expect(inDir({}, () => cdn.url())).rejects.toThrow("no calls expected");
  });

  test("registered drivers and CLOUDGEAR_CDN_DRIVER=memory replace the built-in one", async () => {
    process.env.CLOUDGEAR_CDN_DRIVER = "memory";
    try {
      expect(await new CDN("aws", dns, { cert: new Cert("aws", dns), bucket: site() }).status()).toEqual({ state: "none" });
    } finally {
      delete process.env.CLOUDGEAR_CDN_DRIVER;
    }
    registerCdnDriver("aws", () => ({ describe: async (domain) => ({ state: "deployed", id: domain }) }));
    try {
      expect(await new CDN("aws", dns, { cert: new Cert("aws", dns), bucket: site() }).status()).toEqual({ state: "deployed", id: "cdn.example.com" });
    } finally {
      registerCdnDriver("aws", (await import("../packages/cdn/drivers/cloudfront")).createCloudFrontDriver);
    }
  });

  test("the CloudFront driver finds the distribution by alias across pages", async () => {
    const markers: (string | undefined)[] = [];
    const client = {
      send: async (command: { input: { Marker?: string } }) => {
        markers.push(command.input.Marker);
        return command.input.Marker
          ? { DistributionList: { IsTruncated: false, Items: [{ Id: "E2", Status: "InProgress", DomainName: "d2.cloudfront.net", Aliases: { Items: ["cdn.example.com"] } }] } }
          : { DistributionList: { IsTruncated: true, NextMarker: "m1", Items: [{ Id: "E1", Status: "Deployed", DomainName: "d1.cloudfront.net", Aliases: { Items: ["other.example.com"] } }] } };
      },
    };
    expect(await new CloudFrontCdnDriver(client as never).describe("cdn.example.com")).toEqual({ state: "deploying", id: "E2", url: "https://d2.cloudfront.net" });
    expect(markers).toEqual([undefined, "m1"]);
    const empty = { send: async () => ({ DistributionList: { IsTruncated: false } }) };
    expect(await new CloudFrontCdnDriver(empty as never).describe("cdn.example.com")).toEqual({ state: "none" });
    const done = { send: async () => ({ DistributionList: { Items: [{ Id: "E", Status: "Deployed", DomainName: "d.cloudfront.net", Aliases: { Items: ["cdn.example.com"] } }] } }) };
    expect((await new CloudFrontCdnDriver(done as never).describe("cdn.example.com")).state).toBe("deployed");
  });
});

describe("a Cert without a CDN", () => {
  test("is analyzed and written to the config, even on the zone apex", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cert-only-"));
    const { config } = await generate({ entry: fixture("cdn/cert-only.ts"), configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "certonly" });
    expect(config.certificate).toEqual({ domain: "example.com" });
    expect(config.dns).toMatchObject({ provider: "aws", domain: "example.com" });
    expect(config.cdn).toBeUndefined();
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
