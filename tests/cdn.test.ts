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
  test("a Cert takes its domain from its DNS, a CDN from its Cert", () => {
    const dns = new DNS("gandi", "www.example.com");
    const cert = new Cert("aws", dns);
    const cdn = new CDN("aws", cert, { bucket: site() });
    expect(cert.domain).toBe("www.example.com");
    expect(cdn.domain).toBe("www.example.com");
    expect(new Cert("aws", dns, { region: "eu-west-1" }).region).toBe("eu-west-1");
  });

  test("reject another provider and a foreign bucket", () => {
    const cert = new Cert("aws", new DNS("gandi", "www.example.com"));
    expect(() => new Cert("gcp" as "aws", new DNS("gandi", "x.example.com"))).toThrow(/not supported yet/);
    expect(() => new CDN("gcp" as "aws", cert, { bucket: site() })).toThrow(/CDN provider "gcp" is not supported/);
    expect(() => new CDN("aws", cert, { bucket: new BlobStore("gcp", "://b") })).toThrow(/bucket uses "gcp"/);
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

  test("the ACM driver prefers an issued certificate, then the newest, for exactly that domain", async () => {
    const inputs: unknown[] = [];
    const summary = (arn: string, status: string, at: number, domain = "cdn.example.com") => ({ DomainName: domain, CertificateArn: arn, Status: status, CreatedAt: new Date(at) });
    const client = {
      send: async (command: { input: Record<string, unknown> }) => {
        inputs.push(command.input);
        return command.input.NextToken
          ? { CertificateSummaryList: [summary("arn:newer-failed", "FAILED", 4000), summary("arn:pending", "PENDING_VALIDATION", 3000)] }
          : { NextToken: "t", CertificateSummaryList: [summary("arn:issued", "ISSUED", 1000), summary("arn:other", "ISSUED", 5000, "other.example.com")] };
      },
    };
    const driver = new AcmCertDriver(client as never);
    expect(await driver.describe("cdn.example.com")).toEqual({ state: "issued", id: "arn:issued" });
    expect((inputs[0] as { CertificateStatuses: string[] }).CertificateStatuses).toContain("PENDING_VALIDATION");
    const pendingOnly = { send: async () => ({ CertificateSummaryList: [summary("arn:p", "PENDING_VALIDATION", 1), summary("arn:f", "FAILED", 2)] }) };
    expect(await new AcmCertDriver(pendingOnly as never).describe("cdn.example.com")).toEqual({ state: "pending", id: "arn:p" });
    expect(await new AcmCertDriver({ send: async () => ({}) } as never).describe("x.example.com")).toEqual({ state: "none" });
  });
});

describe("CDN status() and url()", () => {
  const dns = new DNS("gandi", "cdn.example.com");
  const make = (driver: CdnDriver) => new CDN("aws", new Cert("aws", dns), { bucket: site(), driver });
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

  test("url() finds its own site among several in the endpoints file", async () => {
    const driver: CdnDriver = { describe: async () => Promise.reject(new Error("no calls expected")) };
    const cdn = make(driver);
    const written = {
      provider: "aws",
      routes: {},
      cdn: { domain: "files.example.com", url: "https://d111.cloudfront.net" },
      cdns: { "files.example.com": { domain: "files.example.com", url: "https://d111.cloudfront.net" }, "cdn.example.com": { domain: "cdn.example.com", url: "https://d222.cloudfront.net" } },
    };
    expect(await inDir({ "endpoints.json": written }, () => cdn.url())).toBe("https://d222.cloudfront.net");
  });

  test("registered drivers and CLOUDGEAR_CDN_DRIVER=memory replace the built-in one", async () => {
    process.env.CLOUDGEAR_CDN_DRIVER = "memory";
    try {
      expect(await new CDN("aws", new Cert("aws", dns), { bucket: site() }).status()).toEqual({ state: "none" });
    } finally {
      delete process.env.CLOUDGEAR_CDN_DRIVER;
    }
    registerCdnDriver("aws", () => ({ describe: async (domain) => ({ state: "deployed", id: domain }) }));
    try {
      expect(await new CDN("aws", new Cert("aws", dns), { bucket: site() }).status()).toEqual({ state: "deployed", id: "cdn.example.com" });
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
    const { config } = await generate({ entry: fixture("edge/cert-only.ts"), configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "certonly" });
    expect(config.certificate).toEqual([{ provider: "aws", domain: "example.com", dns: { provider: "aws", domain: "example.com", zone: "example.com" } }]);
    expect(config.cdn).toEqual([]);
    expect(config.api).toBeUndefined();
  });
});

describe("FunctionRouter cert option", () => {
  const cert = new Cert("aws", new DNS("gandi", "api.example.com"));
  const echo = (input: unknown) => input;

  test("urls() are on the cert's domain once deployed, with path params left as placeholders", () => {
    const router = new FunctionRouter("aws", {
      cert,
      endpoints: { "GET /objects/{param}": "https://abc.lambda-url.us-east-1.on.aws/" },
    }).url("GET", "/objects/{param}", echo, { name: "getObjects" });
    expect(router.urls()).toEqual({ getObjects: "https://api.example.com/objects/{param}" });
  });

  test("locally, urls() are still the local server's", () => {
    const router = new FunctionRouter("aws", { cert, mode: "local" }).url("GET", "/x", echo, { name: "x" });
    router.listen(0);
    try {
      expect(router.urls().x).toMatch(/^http:\/\/localhost:\d+\/x$/);
    } finally {
      router.stop();
    }
  });
});

describe("generate with certificates, a CDN and an API domain", () => {
  test("writes certificates, cdn and api into the config, and it round-trips", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-cdn-"));
    try {
      const configPath = path.join(dir, "cloudgear.prototxt");
      const { config } = await generate({ entry: fixture("edge/app.ts"), configPath, buildDir: path.join(dir, "build"), project: "edge" });

      expect(config.certificate).toEqual([
        { provider: "aws", domain: "www.example.com", dns: { provider: "gandi", domain: "www.example.com", zone: "example.com" }, usage: "cdn" },
        { provider: "aws", domain: "api.example.com", dns: { provider: "gandi", domain: "api.example.com", zone: "example.com" }, usage: "api" },
      ]);
      expect(config.cdn).toEqual([{ provider: "aws", domain: "www.example.com", bucket: "my-site", path: "web/" }]);
      expect(config.api).toEqual({ provider: "aws", domain: "api.example.com" });

      const text = fs.readFileSync(configPath, "utf8");
      expect(text).toContain('usage: "api"');
      expect(text).toContain('domain: "api.example.com"');
      expect(decodeConfig(text)).toEqual(config);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("functions trust router-supplied identity unless an API domain lets callers reach them directly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-trust-"));
    try {
      const entryOf = (build: string, name: string) => fs.readFileSync(path.join(dir, build, name, "entry.ts"), "utf8");
      await generate({ entry: fixture("edge/app.ts"), configPath: path.join(dir, "a.prototxt"), buildDir: path.join(dir, "api-build") });
      expect(entryOf("api-build", "health")).toContain("trustContext: false");

      await generate({ entry: fixture("edge/bucket-only.ts"), configPath: path.join(dir, "b.prototxt"), buildDir: path.join(dir, "site-build") });
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
      expect(config.certificate).toEqual([]);
      expect(config.cdn).toEqual([]);
      expect(config.api).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a CDN on a wildcard Cert", () => {
  const wildcard = () => new Cert("aws", new DNS("gandi", "*.example.com", { zone: "example.com" }));

  test("serves the hostname it is given, under the wildcard", () => {
    const cdn = new CDN("aws", wildcard(), { bucket: site(), domain: "Files.Example.com" });
    expect(cdn.domain).toBe("files.example.com");
    expect(cdn.cert.domain).toBe("*.example.com");
  });

  test("needs a hostname the wildcard covers", () => {
    expect(() => new CDN("aws", wildcard(), { bucket: site() })).toThrow(/needs the hostname it serves/);
    expect(() => new CDN("aws", wildcard(), { bucket: site(), domain: "a.b.example.com" })).toThrow(/exactly one label/);
    expect(() => new CDN("aws", wildcard(), { bucket: site(), domain: "example.com" })).toThrow(/exactly one label/);
  });

  test("an exact Cert takes no other hostname", () => {
    const exact = new Cert("aws", new DNS("gandi", "www.example.com", { zone: "example.com" }));
    expect(new CDN("aws", exact, { bucket: site(), domain: "www.example.com" }).domain).toBe("www.example.com");
    expect(() => new CDN("aws", exact, { bucket: site(), domain: "other.example.com" })).toThrow(/use a wildcard Cert/);
  });
});
