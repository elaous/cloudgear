import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BlobStore } from "@cloudgear/blob";
import { CDN, Cert, type CdnRouter, type RouteFetchInit } from "@cloudgear/cdn";
import { DNS } from "@cloudgear/dns";
import { FunctionRouter, type FetchOpts } from "@cloudgear/functions";
import { MemoryCdnDriver } from "../packages/cdn/drivers/memory-cdn";

const sha = (data: string) => createHash("sha256").update(data).digest("hex");
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HELLO_SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const DISTRIBUTION = "https://d111.cloudfront.net";

// Compile-time: FunctionRouter and FetchOpts stay assignable to the CDN's structural types.
const _routerFitsCdn: Required<CdnRouter> = new FunctionRouter("aws");
const _optsFitCdn: RouteFetchInit = {} as FetchOpts;
void [_routerFitsCdn, _optsFitCdn];

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  init: RequestInit;
}

describe("cdn.fetch", () => {
  const realFetch = globalThis.fetch;
  const realEndpointsFile = process.env.CLOUDGEAR_ENDPOINTS_FILE;
  let calls: Call[];

  beforeEach(() => {
    process.env.CLOUDGEAR_ENDPOINTS_FILE = "/nonexistent/endpoints.json";
    calls = [];
    globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
      const raw = init.body;
      const body = raw === undefined || raw === null ? "" : typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array);
      calls.push({ url: String(url), method: init.method ?? "GET", headers: new Headers(init.headers), body, init });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realEndpointsFile === undefined) delete process.env.CLOUDGEAR_ENDPOINTS_FILE;
    else process.env.CLOUDGEAR_ENDPOINTS_FILE = realEndpointsFile;
  });

  const deployed = (options: (driver: MemoryCdnDriver) => ConstructorParameters<typeof CDN>[2], url: string | null = DISTRIBUTION) => {
    const driver = new MemoryCdnDriver(new Map());
    if (url) driver.set("api.example.com", { state: "deployed", url });
    return new CDN("aws", new Cert("aws", new DNS("aws", "api.example.com")), { ...options(driver), driver });
  };

  const router = () =>
    new FunctionRouter("aws", { mode: "local" })
      .url("GET", "/items", () => ({}), { name: "list" })
      .url("GET", "/items/{id}", () => ({}), { name: "get" })
      .url("POST", "/items", () => ({}), { name: "create" })
      .url("PUT", "/things/{id}", () => ({}), { name: "put" })
      .url("GET", "/things/{id}", () => ({}), { name: "read" })
      .url("*", "/any", () => ({}), { name: "any" });

  const routerCdn = (url: string | null = DISTRIBUTION) => deployed(() => ({ router: router() }), url);
  const bucketCdn = (url: string | null = DISTRIBUTION) => deployed(() => ({ bucket: new BlobStore("aws", "://my-site") }), url);

  describe("router CDN", () => {
    test("a path goes to the distribution with the route's method", async () => {
      const res = await routerCdn().fetch("/items/42?x=1&y=a%20b");
      expect(await res.text()).toBe("ok");
      expect(calls[0]).toMatchObject({ url: `${DISTRIBUTION}/items/42?x=1&y=a%20b`, method: "GET" });
      expect(calls[0]!.init.redirect).toBe("manual");
    });

    test("a name fills params and query", async () => {
      await routerCdn().fetch("get", { params: { id: "a b" }, query: { x: 1, y: true } });
      expect(calls[0]).toMatchObject({ url: `${DISTRIBUTION}/items/a%20b?x=1&y=true`, method: "GET" });
    });

    test("a name takes the route's method and init.method overrides it", async () => {
      const cdn = routerCdn();
      await cdn.fetch("create", { body: { a: 1 } });
      await cdn.fetch("any", { method: "delete" });
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ["POST", `${DISTRIBUTION}/items`],
        ["DELETE", `${DISTRIBUTION}/any`],
      ]);
    });

    test("a '*' route defaults to GET and accepts any method by path", async () => {
      const cdn = routerCdn();
      await cdn.fetch("/any");
      await cdn.fetch("/any", { method: "PATCH", body: "p" });
      expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    });

    test("a trailing slash on the distribution URL is dropped", async () => {
      await routerCdn(`${DISTRIBUTION}/`).fetch("/items/1");
      expect(calls[0]!.url).toBe(`${DISTRIBUTION}/items/1`);
    });

    test("POST body gets its SHA-256, path and name forms alike", async () => {
      const cdn = routerCdn();
      await cdn.fetch("/items", { method: "POST", body: "hello" });
      await cdn.fetch("create", { body: "hello" });
      await cdn.fetch("/things/1", { method: "PUT" });
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBe(HELLO_SHA);
      expect(calls[0]!.body).toBe("hello");
      expect(calls[1]!.headers.get("x-amz-content-sha256")).toBe(HELLO_SHA);
      expect(calls[2]!.headers.get("x-amz-content-sha256")).toBe(EMPTY_SHA);
      expect(sha("hello")).toBe(HELLO_SHA);
    });

    test("a digest the caller set is kept", async () => {
      const cdn = routerCdn();
      await cdn.fetch("/items", { method: "POST", body: "hello", headers: { "x-amz-content-sha256": "mine" } });
      await cdn.fetch("create", { body: "hello", headers: { "x-amz-content-sha256": "mine" } });
      expect(calls.map((c) => c.headers.get("x-amz-content-sha256"))).toEqual(["mine", "mine"]);
    });

    test("GET carries no digest", async () => {
      const cdn = routerCdn();
      await cdn.fetch("/items/1");
      await cdn.fetch("list");
      expect(calls.map((c) => c.headers.get("x-amz-content-sha256"))).toEqual([null, null]);
    });

    test("the router's own errors come through", async () => {
      const cdn = routerCdn();
      await expect(cdn.fetch("nope")).rejects.toThrow('No route named "nope"; known routes: list, get, create, put, read, any');
      await expect(cdn.fetch("/nope")).rejects.toThrow('No route matches "/nope"');
      await expect(cdn.fetch("/things/1", { method: "POST" })).rejects.toThrow('Method POST is not allowed for "/things/1"; allowed: PUT, GET');
      await expect(cdn.fetch("/items")).rejects.toThrow('"/items" matches routes for GET, POST; pass init.method');
      await expect(cdn.fetch("/items/1", { body: "x" })).rejects.toThrow("A GET request cannot have a body");
      await expect(cdn.fetch("https://evil.example/items")).rejects.toThrow("the router owns the host");
      await expect(cdn.fetch("//evil.example/items")).rejects.toThrow("the router owns the host");
      expect(calls).toEqual([]);
    });

    test("url() throws until the CDN is deployed, before any request", async () => {
      await expect(routerCdn(null).fetch("/items/1")).rejects.toThrow('The CDN for "api.example.com" is not deployed; run cloudgear apply');
      expect(calls).toEqual([]);
    });

    test("a router without fetchVia is refused before url() is asked", async () => {
      const cdn = deployed(() => ({ router: { provider: "aws" } }), null);
      await expect(cdn.fetch("/items")).rejects.toThrow("router has no fetchVia; pass a FunctionRouter");
      expect(calls).toEqual([]);
    });

    test("init.redirect overrides the manual default", async () => {
      await routerCdn().fetch("/items/1", { redirect: "follow" });
      expect(calls[0]!.init.redirect).toBe("follow");
    });

    test("binary and FormData bodies are hashed as sent", async () => {
      const cdn = routerCdn();
      const bytes = new Uint8Array([0, 255, 1, 128]);
      await cdn.fetch("/things/1", { method: "PUT", body: bytes });
      const form = new FormData();
      form.append("a", "1");
      await cdn.fetch("/things/2", { method: "PUT", body: form });
      const sent = (call: Call) => createHash("sha256").update(call.init.body as Uint8Array).digest("hex");
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(calls[1]!.headers.get("x-amz-content-sha256")).toBe(sent(calls[1]!));
      expect(calls[1]!.headers.get("content-type")).toStartWith("multipart/form-data; boundary=");
    });

    test("a stream body is hashed as sent", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hel"));
          controller.enqueue(new TextEncoder().encode("lo"));
          controller.close();
        },
      });
      await routerCdn().fetch("/items", { method: "POST", body: stream, duplex: "half" } as RequestInit);
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBe(HELLO_SHA);
    });

    test("router.fetch is not affected by a CDN fetch", async () => {
      const served = router();
      const cdn = deployed(() => ({ router: served }));
      await cdn.fetch("/items/1");
      const res = await served.fetch(new Request("http://app/items/1"));
      expect(res.status).toBe(200);
    });
  });

  describe("endpoints file", () => {
    const withEndpoints = async (api: object | undefined) => {
      const file = `${process.env.TMPDIR ?? "/tmp"}/cloudgear-cdn-fetch-${crypto.randomUUID()}.json`;
      await Bun.write(file, JSON.stringify({ provider: "aws", routes: { "GET /items": "https://fn.example/", "GET /items/{id}": "https://fn.example/" }, auth: "none", ...(api ? { api } : {}) }));
      process.env.CLOUDGEAR_ENDPOINTS_FILE = file;
      const served = new FunctionRouter("aws", { endpointsFile: file }).url("GET", "/items", () => ({}), { name: "list" }).url("GET", "/items/{id}", () => ({}), { name: "get" });
      const driver = new MemoryCdnDriver(new Map());
      return { served, cdn: new CDN("aws", new Cert("aws", new DNS("aws", "api.example.com")), { router: served, driver }) };
    };
    const hosts = () => calls.map((c) => new URL(c.url).host);

    for (const [label, api] of [
      ["via cloudfront", { domain: "api.example.com", url: DISTRIBUTION, via: "cloudfront" }],
      ["an older file with a distribution URL", { domain: "api.example.com", url: DISTRIBUTION }],
    ] as const) {
      test(`${label}: url(), cdn.fetch and router.fetch agree without the provider`, async () => {
        const { served, cdn } = await withEndpoints(api);
        expect(await cdn.url()).toBe("https://api.example.com");
        await cdn.fetch("list");
        await cdn.fetch("/items/1");
        await served.fetch("list");
        expect(hosts()).toEqual(["api.example.com", "api.example.com", "api.example.com"]);
        expect(calls[0]!.url).toBe("https://api.example.com/items");
      });
    }

    test("an API Gateway entry for the same domain is not a CDN", async () => {
      const { cdn } = await withEndpoints({ domain: "api.example.com", url: "https://abc.execute-api.us-east-1.amazonaws.com" });
      await expect(cdn.url()).rejects.toThrow("is not deployed");
    });

    test("another domain's api entry is ignored", async () => {
      const { cdn } = await withEndpoints({ domain: "other.example.com", url: DISTRIBUTION, via: "cloudfront" });
      await expect(cdn.url()).rejects.toThrow("is not deployed");
    });
  });

  describe("bucket CDN", () => {
    test("GET and HEAD go to the distribution", async () => {
      const cdn = bucketCdn();
      await cdn.fetch("/index.html");
      await cdn.fetch("assets/app.js?v=2", { method: "head" });
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ["GET", `${DISTRIBUTION}/index.html`],
        ["HEAD", `${DISTRIBUTION}/assets/app.js?v=2`],
      ]);
      expect(calls.map((c) => c.headers.get("x-amz-content-sha256"))).toEqual([null, null]);
    });

    test("dot segments inside the root are normalised", async () => {
      await bucketCdn().fetch("/a/b/../c.txt");
      expect(calls[0]!.url).toBe(`${DISTRIBUTION}/a/c.txt`);
    });

    test("writes are refused", async () => {
      const cdn = bucketCdn();
      for (const method of ["PUT", "POST", "PATCH", "DELETE", "OPTIONS"]) {
        await expect(cdn.fetch("/index.html", { method })).rejects.toThrow(`read-only: ${method} is not allowed`);
      }
      expect(calls).toEqual([]);
    });

    test("a body is refused", async () => {
      await expect(bucketCdn().fetch("/index.html", { body: "x" })).rejects.toThrow("A GET request cannot have a body");
    });

    test("escaping the root is rejected", async () => {
      const cdn = bucketCdn();
      for (const input of ["/../secret", "../secret", "/a/../../secret", "/%2e%2e/secret", "/a/%2E%2e/%2e%2E/secret"]) {
        await expect(cdn.fetch(input)).rejects.toThrow("leaves the CDN's root");
      }
      expect(calls).toEqual([]);
    });

    test("control characters cannot hide a dot segment", async () => {
      const cdn = bucketCdn();
      await expect(cdn.fetch("/a/.\n./../x")).rejects.toThrow("leaves the CDN's root");
      await expect(cdn.fetch("/.\t./x")).rejects.toThrow("leaves the CDN's root");
      await cdn.fetch("/a/b/.\r./x");
      expect(calls[0]!.url).toBe(`${DISTRIBUTION}/a/x`);
    });

    test("encoded slashes and ..; stay literal", async () => {
      const cdn = bucketCdn();
      await cdn.fetch("/a%2f..%2fx");
      await cdn.fetch("/..;/x");
      await cdn.fetch("/a/..%2f..%2fx");
      expect(calls.map((c) => c.url)).toEqual([`${DISTRIBUTION}/a%2f..%2fx`, `${DISTRIBUTION}/..;/x`, `${DISTRIBUTION}/a/..%2f..%2fx`]);
    });

    test("absolute URLs are rejected", async () => {
      const cdn = bucketCdn();
      for (const input of ["https://evil.example/x", "//evil.example/x", "\\\\evil.example\\x"]) {
        await expect(cdn.fetch(input)).rejects.toThrow("the CDN owns the host");
      }
      expect(calls).toEqual([]);
    });

    test("init.redirect overrides the manual default", async () => {
      await bucketCdn().fetch("/index.html", { redirect: "follow" });
      expect(calls[0]!.init.redirect).toBe("follow");
    });

    test("url() throws until the CDN is deployed", async () => {
      await expect(bucketCdn(null).fetch("/index.html")).rejects.toThrow("is not deployed");
      expect(calls).toEqual([]);
    });
  });
});
