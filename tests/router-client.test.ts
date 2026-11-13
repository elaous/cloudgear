import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FunctionRouter, type FunctionRouterOptions } from "@cloudgear/functions";

const sha = (data: string) => createHash("sha256").update(data).digest("hex");
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const credentials = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" });
const FUNCTION_URL = "https://abc.lambda-url.us-east-1.on.aws/";

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  init: RequestInit;
}

describe("router.fetch(path, init)", () => {
  const realFetch = globalThis.fetch;
  let calls: Call[];
  let local: FunctionRouter | undefined;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
      const raw = init.body;
      const body = raw === undefined || raw === null ? "" : typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array);
      calls.push({ url: String(url), method: init.method ?? "GET", headers: new Headers(init.headers), body, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    local?.stop();
    local = undefined;
  });

  const routes = (options: FunctionRouterOptions) =>
    new FunctionRouter("aws", options)
      .url("GET", "/items", () => ({}), { name: "list" })
      .url("GET", "/items/{id}", () => ({}), { name: "get" })
      .url("POST", "/items", () => ({}), { name: "create" })
      .url("PUT", "/things/{id}", () => ({}), { name: "put" })
      .url("GET", "/things/{id}", () => ({}), { name: "read" })
      .url("DELETE", "/gone", () => ({}), { name: "gone" })
      .url("PATCH", "/y", () => ({}), { name: "patch-y" })
      .url("HEAD", "/y", () => ({}), { name: "head-y" })
      .url("OPTIONS", "/y", () => ({}), { name: "options-y" })
      .url("POST", "/y", () => ({}), { name: "post-y" })
      .url("GET", "/colon", () => ({}), { name: "v1:thing" });

  const withEndpointsFile = async (file: object, options: FunctionRouterOptions = {}) => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/cloudgear-client-${crypto.randomUUID()}.json`;
    await Bun.write(path, JSON.stringify(file));
    return routes({ endpointsFile: path, ...options });
  };

  const cdnEndpoints = (via?: "cloudfront") => ({
    provider: "aws",
    routes: { "GET /items": FUNCTION_URL, "POST /items": FUNCTION_URL, "GET /items/{id}": FUNCTION_URL },
    auth: "iam",
    api: { domain: "api.example.com", url: "https://api.example.com", ...(via ? { via } : {}) },
  });

  describe("form (1)", () => {
    test("a Request is served and the second argument is ignored", async () => {
      const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/items/{id}", (input: { id: string }) => ({ id: input.id }));
      const serverLike = { url: new URL("http://localhost:3000/"), port: 3000 };
      const res = await router.fetch(new Request("http://app/items/7?a=1"), serverLike);
      expect(await res.json()).toEqual({ id: "7" });
      const missing = await router.fetch(new Request("http://app/nope"), serverLike);
      expect(missing.status).toBe(404);
      expect(calls).toEqual([]);
    });

    test("Bun.serve hands its server object as the second argument", async () => {
      const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/items/{id}", (input: { id: string }) => ({ id: input.id }));
      const server = Bun.serve({ port: 0, fetch: router.fetch });
      globalThis.fetch = realFetch;
      try {
        const res = await fetch(`${server.url.origin}/items/9`);
        expect(await res.json()).toEqual({ id: "9" });
      } finally {
        server.stop(true);
      }
    });
  });

  describe("input", () => {
    test("path params and the query string reach the target", async () => {
      await (await withEndpointsFile(cdnEndpoints("cloudfront"))).fetch("/items/42?x=1&y=a%20b");
      expect(calls[0]).toMatchObject({ url: "https://api.example.com/items/42?x=1&y=a%20b", method: "GET" });
    });

    test("URL objects must be http(s) and are rejected for their host", async () => {
      const router = await withEndpointsFile(cdnEndpoints());
      await expect(router.fetch(new URL("file:///items/5?z=2"))).rejects.toThrow(/got a file: URL/);
      await expect(router.fetch(new URL("http://app/items/5"))).rejects.toThrow(/the router owns the host/);
      expect(calls).toEqual([]);
    });

    test("a route name with a colon stays a name", async () => {
      const router = await withEndpointsFile(cdnEndpoints("cloudfront"));
      await router.fetch("v1:thing");
      expect(calls[0]!.url).toBe("https://api.example.com/colon");
    });

    test("names that look like paths or URLs are refused at registration", () => {
      const router = new FunctionRouter("aws", { mode: "local" });
      for (const name of ["/x", "\\x", "https://x", "a+b://c"]) {
        expect(() => router.url("GET", "/p", () => ({}), { name })).toThrow(/must not start with/);
      }
      expect(() => router.url("GET", "/p", () => ({}), { name: "users:list" })).not.toThrow();
    });

    test("a body on GET or HEAD throws before sending", async () => {
      const router = await withEndpointsFile(cdnEndpoints("cloudfront"));
      await expect(router.fetch("/items/1", { body: "x" })).rejects.toThrow(/A GET request cannot have a body/);
      await expect(router.fetch("/y", { method: "HEAD", body: "x" })).rejects.toThrow(/A HEAD request cannot have a body/);
      expect(calls).toEqual([]);
    });

    test("dot segments are normalised before matching", async () => {
      await (await withEndpointsFile(cdnEndpoints("cloudfront"))).fetch("/x/../y", { method: "POST", body: "a" });
      expect(calls[0]!.url).toBe("https://api.example.com/y");
    });

    test("HEAD and OPTIONS carry no digest, PATCH does", async () => {
      const router = await withEndpointsFile(cdnEndpoints("cloudfront"));
      await router.fetch("/y", { method: "HEAD" });
      await router.fetch("/y", { method: "OPTIONS" });
      await router.fetch("/y", { method: "PATCH", body: "p" });
      await router.fetch("/y", { method: "PATCH" });
      expect(calls.map((c) => c.method)).toEqual(["HEAD", "OPTIONS", "PATCH", "PATCH"]);
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBeNull();
      expect(calls[1]!.headers.get("x-amz-content-sha256")).toBeNull();
      expect(calls[2]!.headers.get("x-amz-content-sha256")).toBe(sha("p"));
      expect(calls[3]!.headers.get("x-amz-content-sha256")).toBe(EMPTY_SHA);
    });

    test("an OPTIONS request with a body is hashed too", async () => {
      await (await withEndpointsFile(cdnEndpoints("cloudfront"))).fetch("/y", { method: "OPTIONS", body: "o" });
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBe(sha("o"));
    });

    test("the method defaults to the route's and init.method is case-insensitive", async () => {
      const router = await withEndpointsFile(cdnEndpoints());
      await router.fetch("/gone");
      await router.fetch("/items", { method: "post", body: "x" });
      expect(calls.map((c) => c.method)).toEqual(["DELETE", "POST"]);
    });

    test("a method no route has for the path throws", async () => {
      const router = await withEndpointsFile(cdnEndpoints());
      await expect(router.fetch("/gone", { method: "POST" })).rejects.toThrow(/Method POST is not allowed for "\/gone"; allowed: DELETE/);
      expect(calls).toEqual([]);
    });

    test("several methods on one path need init.method", async () => {
      const router = await withEndpointsFile(cdnEndpoints());
      await expect(router.fetch("/items")).rejects.toThrow(/matches routes for GET, POST; pass init.method/);
      await router.fetch("/items", { method: "GET" });
      expect(calls).toHaveLength(1);
    });

    test("a path without a route throws and does not use the network", async () => {
      const router = await withEndpointsFile(cdnEndpoints());
      await expect(router.fetch("/nothing")).rejects.toThrow(/No route matches "\/nothing"/);
      expect(calls).toEqual([]);
    });

    test("absolute URLs are rejected", async () => {
      const router = await withEndpointsFile(cdnEndpoints());
      for (const input of ["https://evil.test/items", "//evil.test/items", "http://api.example.com/items", "\\\\evil.test/items", "/\\evil.test/items"]) {
        await expect(router.fetch(input)).rejects.toThrow(/without a host/);
      }
      await expect(router.fetch(new URL("https://api.example.com/items"))).rejects.toThrow(/the router owns the host/);
      expect(calls).toEqual([]);
    });

    test("malformed percent-encoding throws", async () => {
      const router = await withEndpointsFile(cdnEndpoints());
      await expect(router.fetch("/items/%zz")).rejects.toThrow(/Malformed path/);
    });

    test("route names still work", async () => {
      const router = await withEndpointsFile(cdnEndpoints("cloudfront"));
      await router.fetch("get", { params: { id: "3" } });
      expect(calls[0]!.url).toBe("https://api.example.com/items/3");
    });
  });

  describe("host resolution", () => {
    test("local mode calls the listening server", async () => {
      local = new FunctionRouter("aws", { mode: "local" }).url("GET", "/items/{id}", (input: { id: string }) => ({ id: input.id }));
      globalThis.fetch = realFetch;
      local.listen(0);
      const spy: string[] = [];
      globalThis.fetch = ((url: unknown, init?: RequestInit) => {
        spy.push(String(url));
        return realFetch(url as string, init);
      }) as typeof fetch;
      const res = await local.fetch("/items/8?q=1");
      expect(await res.json()).toEqual({ id: "8" });
      expect(spy[0]).toBe(`${local.urls()["GET /items/{id}"]!.replace("{id}", "8")}?q=1`);
    });

    test("local mode without listen() throws like urls()", async () => {
      const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/items", () => ({}));
      await expect(router.fetch("/items")).rejects.toThrow(/not listening; call listen\(\) first/);
    });

    test("the API domain is used and nothing is wrapped or signed", async () => {
      const router = await withEndpointsFile(cdnEndpoints(), { credentials });
      await router.fetch("/items", { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "content-type": "application/json" } });
      expect(calls[0]).toMatchObject({ url: "https://api.example.com/items", method: "POST", body: '{"a":1}' });
      expect(calls[0]!.headers.get("authorization")).toBeNull();
      expect(calls[0]!.headers.get("x-amz-date")).toBeNull();
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBeNull();
      expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    });

    test("the cert option names the API Gateway domain", async () => {
      const router = routes({ mode: "remote", endpoints: { "GET /items": FUNCTION_URL }, cert: { domain: "gw.example.com" } });
      await router.fetch("/items", { method: "GET" });
      expect(calls[0]!.url).toBe("https://gw.example.com/items");
    });

    test("a CDN-served router resolves to its domain", async () => {
      await (await withEndpointsFile(cdnEndpoints("cloudfront"))).fetch("/items/1");
      expect(calls[0]!.url).toBe("https://api.example.com/items/1");
    });

    test("a site CDN in the endpoints file is not used for routes", async () => {
      const file = { ...cdnEndpoints(), api: undefined, cdn: { domain: "site.example.com", url: "https://site.example.com" } };
      const router = await withEndpointsFile(file, { authenticated: "none" });
      await router.fetch("/items", { method: "GET" });
      expect(calls[0]!.url).toBe(FUNCTION_URL);
    });

    test("without a domain the function URL gets the invoke envelope, signed when IAM", async () => {
      const router = await withEndpointsFile({ ...cdnEndpoints(), api: undefined }, { credentials, region: "us-east-1" });
      const res = await router.fetch("/items/5?q=1");
      expect(await res.json()).toEqual({ ok: true });
      const [call] = calls;
      expect(call!.url).toBe(FUNCTION_URL.replace("/items", ""));
      expect(call!.method).toBe("POST");
      expect(call!.headers.get("content-type")).toBe("application/vnd.cloudgear.invoke+json");
      expect(call!.headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/");
      expect(call!.headers.get("x-cloudgear-route")).toBe("GET /items/{id}");
      expect(JSON.parse(call!.body)).toEqual({ input: { id: "5", q: "1" }, context: {} });
    });

    test("a function URL without IAM is sent unsigned", async () => {
      const router = await withEndpointsFile({ ...cdnEndpoints(), api: undefined, auth: "none" });
      await router.fetch("/items/5");
      expect(calls[0]!.headers.get("authorization")).toBeNull();
      expect(JSON.parse(calls[0]!.body).input).toEqual({ id: "5" });
    });

    test("the function URL case keeps the JSON body as input and refuses unsupported init", async () => {
      const router = await withEndpointsFile({ ...cdnEndpoints(), api: undefined, auth: "none" });
      await router.fetch("/items", { method: "POST", body: JSON.stringify({ n: 1 }), headers: { "content-type": "application/json" } });
      expect(JSON.parse(calls[0]!.body).input).toEqual({ n: 1 });
      await expect(router.fetch("/items", { method: "GET", cache: "no-store" } as RequestInit)).rejects.toThrow(/does not support init.cache/);
    });

    test("a route without a deployed function URL throws", async () => {
      const router = routes({ mode: "remote", endpoints: { "GET /items": FUNCTION_URL }, authenticated: "none" });
      await expect(router.fetch("/gone")).rejects.toThrow(/has no URL yet/);
    });
  });

  describe("x-amz-content-sha256", () => {
    test("POST and PUT through a CDN carry the digest of the exact bytes", async () => {
      const router = await withEndpointsFile({ ...cdnEndpoints("cloudfront"), routes: { ...cdnEndpoints().routes, "PUT /things/{id}": FUNCTION_URL } });
      await router.fetch("/items", { method: "POST", body: '{"a":1}' });
      await router.fetch("/things/1", { method: "PUT", body: new TextEncoder().encode("héllo") });
      await router.fetch("/items", { method: "POST" });
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBe(sha('{"a":1}'));
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
      expect(calls[1]!.headers.get("x-amz-content-sha256")).toBe(sha("héllo"));
      expect(calls[2]!.headers.get("x-amz-content-sha256")).toBe(EMPTY_SHA);
      expect(calls[0]!.body).toBe('{"a":1}');
    });

    test("an explicit header is kept", async () => {
      const router = await withEndpointsFile(cdnEndpoints("cloudfront"));
      await router.fetch("/items", { method: "POST", body: "x", headers: { "X-Amz-Content-Sha256": "caller" } });
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBe("caller");
    });

    test("GET through a CDN has no digest", async () => {
      await (await withEndpointsFile(cdnEndpoints("cloudfront"))).fetch("/items/1");
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBeNull();
    });

    test("API Gateway targets get no digest on POST", async () => {
      await (await withEndpointsFile(cdnEndpoints())).fetch("/items", { method: "POST", body: "x" });
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBeNull();
    });

    test("local targets get no digest on POST", async () => {
      local = new FunctionRouter("aws", { mode: "local" }).url("POST", "/echo", () => ({}));
      local.listen(0);
      const origin = local.urls()["POST /echo"]!.replace("/echo", "");
      await local.fetch("/echo", { method: "POST", body: "x" });
      expect(calls[0]).toMatchObject({ url: `${origin}/echo`, method: "POST" });
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBeNull();
    });

    test("URLSearchParams, Blob, FormData and stream bodies are hashed as serialized", async () => {
      const router = await withEndpointsFile(cdnEndpoints("cloudfront"));
      const form = new FormData();
      form.set("a", "1");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("str"));
          controller.enqueue(new TextEncoder().encode("eam"));
          controller.close();
        },
      });
      await router.fetch("/y", { method: "POST", body: new URLSearchParams({ a: "1 2" }) });
      await router.fetch("/y", { method: "POST", body: new Blob(["blob"]) });
      await router.fetch("/y", { method: "POST", body: form });
      await router.fetch("/y", { method: "POST", body: stream, duplex: "half" } as RequestInit);
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBe(sha("a=1+2"));
      expect(calls[1]!.headers.get("x-amz-content-sha256")).toBe(sha("blob"));
      expect(calls[2]!.headers.get("content-type")).toStartWith("multipart/form-data; boundary=");
      expect(calls[2]!.headers.get("x-amz-content-sha256")).toBe(sha(calls[2]!.body));
      expect(calls[3]!.headers.get("x-amz-content-sha256")).toBe(sha("stream"));
      expect(calls[3]!.body).toBe("stream");
    });

    test("an old endpoints file infers CloudFront from the api url", async () => {
      const file = { ...cdnEndpoints(), api: { domain: "api.example.com", url: "https://d111.cloudfront.net" } };
      await (await withEndpointsFile(file)).fetch("/items", { method: "POST", body: "x" });
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBe(sha("x"));
    });

    test("an old endpoints file for API Gateway gets no digest", async () => {
      const file = { ...cdnEndpoints(), api: { domain: "api.example.com", url: "https://abc.execute-api.us-east-1.amazonaws.com" } };
      await (await withEndpointsFile(file)).fetch("/items", { method: "POST", body: "x" });
      expect(calls[0]!.headers.get("x-amz-content-sha256")).toBeNull();
    });

    test("init.redirect overrides the manual default", async () => {
      await (await withEndpointsFile(cdnEndpoints("cloudfront"))).fetch("/items/1", { redirect: "follow" });
      expect(calls[0]!.init.redirect).toBe("follow");
    });

    test("other init fields pass through and redirects stay manual", async () => {
      const router = await withEndpointsFile(cdnEndpoints("cloudfront"));
      const signal = new AbortController().signal;
      await router.fetch("/items/1", { signal, headers: { "x-extra": "1" } });
      expect(calls[0]!.init.redirect).toBe("manual");
      expect(calls[0]!.init.signal).toBe(signal);
      expect(calls[0]!.headers.get("x-extra")).toBe("1");
    });
  });
});
