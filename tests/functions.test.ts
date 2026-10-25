import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FunctionRouter, INVOKE_CONTENT_TYPE, response } from "@cloudgear/functions";
import { createHandler, type FunctionUrlEvent } from "@cloudgear/functions/drivers/aws";
import { regionFromUrl } from "../packages/functions/sign";
import { buildInput, compilePath, matchPath } from "../packages/functions/http";

const echo = (input: Record<string, unknown>) => input;

describe("http helpers", () => {
  test("matches path params and decodes them", () => {
    const compiled = compilePath("/foo/{param}/bar/{id}");
    expect(matchPath(compiled, "/foo/a%20b/bar/7")).toEqual({ param: "a b", id: "7" });
    expect(matchPath(compiled, "/foo/a/bar/7/")).toEqual({ param: "a", id: "7" });
    expect(matchPath(compiled, "/foo/a/baz/7")).toBeNull();
  });

  test("buildInput layers body < query < path params", () => {
    const input = buildInput(
      { name: "body", param: "body", q: "body" },
      new URLSearchParams("q=query&tag=a&tag=b&param=query"),
      { param: "path" },
    );
    expect(input).toEqual({ name: "body", q: "query", tag: ["a", "b"], param: "path" });
  });

  test("__proto__ keys become plain data and never change the prototype", () => {
    const body = JSON.parse('{"__proto__":{"admin":true},"id":"1"}');
    const input = buildInput(body, new URLSearchParams("tag=a"), {});
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    expect((input as any).admin).toBeUndefined();
    expect(JSON.parse(JSON.stringify(input))).toEqual({ ["__proto__"]: { admin: true }, id: "1", tag: "a" });

    const fromQuery = buildInput(undefined, new URLSearchParams("__proto__=a&__proto__=b"), {});
    expect(Object.getPrototypeOf(fromQuery)).toBe(Object.prototype);
    expect(Object.keys(fromQuery)).toEqual(["__proto__"]);
  });

  test("a non-object body is exposed as input.body", () => {
    expect(buildInput([1, 2], new URLSearchParams(), {})).toEqual({ body: [1, 2] });
  });
});

describe("FunctionRouter (local mode)", () => {
  const router = new FunctionRouter("aws", { mode: "local" })
    .url("POST", "/foo/{param}", (input: { name: string; param: string; q?: string }) => ({
      greeting: `${input.name}:${input.param}:${input.q}`,
      at: new Date(0),
    }))
    .url("GET", "/missing", () => response({ error: "nope" }, { status: 404, headers: { "x-test": "1" } }))
    .url("GET", "/boom", () => {
      throw new Error("kaboom");
    });

  test("builds the input object and serializes the output", async () => {
    const res = await router.fetch(
      new Request("http://app/foo/42?q=hi", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ada" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ greeting: "ada:42:hi", at: "1970-01-01T00:00:00.000Z" });
  });

  test("honours response() status and headers", async () => {
    const res = await router.fetch(new Request("http://app/missing"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-test")).toBe("1");
  });

  test("turns thrown errors into generic 500s and logs the cause", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await router.fetch(new Request("http://app/boom"));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal Server Error" });
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  test("answers 400 for malformed percent-encoding and invalid JSON", async () => {
    const r = new FunctionRouter("aws", { mode: "local" }).url("POST", "/p/{id}", echo);
    expect((await r.fetch(new Request("http://app/p/%E0%A4%A", { method: "POST" }))).status).toBe(400);
    const bad = await r.fetch(
      new Request("http://app/p/1", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
    );
    expect(bad.status).toBe(400);
  });

  test("404 for unknown paths, 405 for a known path with another method", async () => {
    expect((await router.fetch(new Request("http://app/nope"))).status).toBe(404);
    expect((await router.fetch(new Request("http://app/foo/1"))).status).toBe(405);
  });

  test("rejects duplicate routes and bad methods", () => {
    const r = new FunctionRouter("aws").url("GET", "/a", echo);
    expect(() => r.url("get", "/a", echo)).toThrow(/already registered/);
    expect(() => r.url("TRACE" as "GET", "/b", echo)).toThrow(/Unsupported HTTP method/);
  });
});

describe("FunctionRouter route names and urls", () => {
  const local = {
    getObjects: (input: { param: string }) => input,
  };

  test("names default to the function's name and options.name overrides it", () => {
    const router = new FunctionRouter("aws", { mode: "local" })
      .url("GET", "/objects/{param}", local.getObjects)
      .url("POST", "/objects/{param}", local.getObjects, { name: "putObject" })
      .url("GET", "/health", () => ({}));
    const server = router.listen(0);
    try {
      const urls = router.urls();
      expect(Object.keys(urls)).toEqual(["getObjects", "putObject", "GET /health"]);
      expect(urls.getObjects).toBe(`${new URL(Object.values(urls)[0]!).origin}/objects/{param}`);
    } finally {
      router.stop();
    }
    expect(server.getObjects).toBe(server.putObject);
  });

  test("listen() returns URLs by name and the server answers on them", async () => {
    const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/ping/{id}", (input: { id: string }) => ({ pong: input.id }), { name: "ping" });
    const urls = router.listen(0);
    try {
      const res = await fetch(urls.ping!.replace("{id}", "7"));
      expect(await res.json()).toEqual({ pong: "7" });
    } finally {
      router.stop();
    }
  });

  test("listen() does nothing inside Lambda", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "fn";
    try {
      const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/x", echo);
      expect(router.listen(0)).toEqual({});
      expect(() => router.urls()).toThrow(/call listen\(\) first/);
    } finally {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    }
  });

  test("in remote mode urls() are the deployed function URLs plus the route path", () => {
    const router = new FunctionRouter("aws", {
      endpoints: { "GET /objects/{param}": "https://abc.lambda-url.us-east-1.on.aws/" },
    }).url("GET", "/objects/{param}", local.getObjects);
    expect(router.urls()).toEqual({ getObjects: "https://abc.lambda-url.us-east-1.on.aws/objects/{param}" });
  });

  test("urls() before listen() with nothing deployed explains what to do", () => {
    const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/x", echo);
    expect(() => router.urls()).toThrow(/call listen\(\) first/);
  });

  test("rejects duplicate and empty names", () => {
    const router = new FunctionRouter("aws").url("GET", "/a", echo, { name: "one" });
    expect(() => router.url("GET", "/b", echo, { name: "one" })).toThrow(/Route name "one" is already used/);
    expect(() => router.url("GET", "/c", echo, { name: "" })).toThrow();
    expect(() => router.url("GET", "/d", () => ({})).url("GET", "/e", () => ({}))).not.toThrow();
  });
});

describe("FunctionRouter rate limit", () => {
  const limited = (windowMs = 1000) =>
    new FunctionRouter("aws", { mode: "local", rateLimit: { limit: 2, windowMs, key: (req) => req.headers.get("x-client") ?? "anon" } }).url(
      "GET",
      "/x",
      () => ({ ok: true }),
    );
  const call = (router: FunctionRouter, client: string) =>
    router.fetch(new Request("http://app/x", { headers: { "x-client": client } }));

  test("rejects requests over the limit with 429 and Retry-After, per client", async () => {
    const router = limited();
    expect((await call(router, "a")).status).toBe(200);
    expect((await call(router, "a")).status).toBe(200);
    const blocked = await call(router, "a");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await call(router, "b")).status).toBe(200);
  });

  test("counts requests to unknown paths too, and starts a new window after windowMs", async () => {
    const router = limited(40);
    await router.fetch(new Request("http://app/nope", { headers: { "x-client": "a" } }));
    await call(router, "a");
    expect((await call(router, "a")).status).toBe(429);
    await Bun.sleep(60);
    expect((await call(router, "a")).status).toBe(200);
  });

  test("defaults the client to the first X-Forwarded-For address", async () => {
    const router = new FunctionRouter("aws", { mode: "local", rateLimit: { limit: 1, windowMs: 1000 } }).url("GET", "/x", () => ({}));
    const get = (ip: string) => router.fetch(new Request("http://app/x", { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } }));
    expect((await get("1.1.1.1")).status).toBe(200);
    expect((await get("1.1.1.1")).status).toBe(429);
    expect((await get("2.2.2.2")).status).toBe(200);
  });
});

describe("FunctionRouter (remote mode)", () => {
  const servers: { stop(force?: boolean): void }[] = [];
  afterEach(() => {
    while (servers.length) servers.pop()!.stop(true);
  });

  // Stands in for a Lambda function URL: HTTP request -> payload v2 event -> adapter.
  function fakeFunctionUrl(handler: ReturnType<typeof createHandler>) {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const event: FunctionUrlEvent = {
          rawPath: url.pathname,
          rawQueryString: url.search.slice(1),
          headers: Object.fromEntries(req.headers),
          body: await req.text(),
          requestContext: { http: { method: req.method } },
        };
        const result = await handler(event);
        return new Response(result.body, { status: result.statusCode, headers: result.headers });
      },
    });
    servers.push(server);
    return server.url.href;
  }

  test("posts the assembled input to the function URL", async () => {
    const url = fakeFunctionUrl(createHandler(echo, [{ method: "POST", path: "/foo/{param}" }]));
    const router = new FunctionRouter("aws", { endpoints: { "POST /foo/{param}": url }, authenticated: "none" }).url(
      "POST",
      "/foo/{param}",
      (input: { param: string }) => input,
    );
    expect(router.mode).toBe("remote");

    const res = await router.fetch(
      new Request("http://app/foo/9?q=x", { method: "POST", body: JSON.stringify({ name: "n" }), headers: { "content-type": "application/json" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "n", q: "x", param: "9" });
  });

  test("502 when a route has no deployed endpoint", async () => {
    const router = new FunctionRouter("aws", { endpoints: {} }).url("GET", "/x", echo);
    expect((await router.fetch(new Request("http://app/x"))).status).toBe(502);
  });

  test("502 when the function URL is unreachable", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const router = new FunctionRouter("aws", { endpoints: { "GET /x": "http://127.0.0.1:1/" }, authenticated: "none" }).url("GET", "/x", echo);
      const res = await router.fetch(new Request("http://app/x"));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "Function unreachable" });
    } finally {
      log.mockRestore();
    }
  });

  describe("IAM signing", () => {
    const credentials = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" });
    const original = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = original;
    });
    const captureFetch = () => {
      const seen: { url: string; headers: Headers; body: string }[] = [];
      globalThis.fetch = (async (url: unknown, init: RequestInit) => {
        seen.push({ url: String(url), headers: new Headers(init.headers), body: String(init.body) });
        return new Response("{}");
      }) as typeof fetch;
      return seen;
    };

    test("signs router calls with SigV4 for the lambda service and the URL's region", async () => {
      const seen = captureFetch();
      const url = "https://abc123.lambda-url.eu-west-1.on.aws/";
      const router = new FunctionRouter("aws", { endpoints: { "GET /x": url }, credentials }).url("GET", "/x", echo);
      await router.fetch(new Request("http://app/x?a=1"));

      const headers = seen[0]!.headers;
      expect(headers.get("authorization")).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/lambda\/aws4_request, SignedHeaders=.*content-type.*host.*, Signature=[0-9a-f]{64}$/,
      );
      expect(headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
      expect(headers.get("content-type")).toBe(INVOKE_CONTENT_TYPE);
      expect(JSON.parse(seen[0]!.body)).toEqual({ a: "1" });
    });

    test("the signature matches an independent computation over the same request", async () => {
      const seen = captureFetch();
      const url = "https://abc123.lambda-url.us-east-1.on.aws/";
      await new FunctionRouter("aws", { endpoints: { "GET /x": url }, credentials }).url("GET", "/x", echo).fetch(new Request("http://app/x"));
      const sent = seen[0]!;
      const amz = sent.headers.get("x-amz-date")!;
      const when = new Date(Date.UTC(+amz.slice(0, 4), +amz.slice(4, 6) - 1, +amz.slice(6, 8), +amz.slice(9, 11), +amz.slice(11, 13), +amz.slice(13, 15)));

      const { SignatureV4 } = await import("@smithy/signature-v4");
      const { HttpRequest } = await import("@smithy/protocol-http");
      const { Sha256 } = await import("@aws-crypto/sha256-js");
      const expected = await new SignatureV4({ credentials, region: "us-east-1", service: "lambda", sha256: Sha256 }).sign(
        new HttpRequest({
          method: "POST",
          protocol: "https:",
          hostname: "abc123.lambda-url.us-east-1.on.aws",
          path: "/",
          headers: { "content-type": INVOKE_CONTENT_TYPE, "x-cloudgear-route": "GET /x", host: "abc123.lambda-url.us-east-1.on.aws" },
          body: sent.body,
        }),
        { signingDate: when },
      );
      expect(sent.headers.get("authorization")).toBe(expected.headers["authorization"]!);
    });

    test("forwards a session token from temporary credentials", async () => {
      const seen = captureFetch();
      const temporary = async () => ({ accessKeyId: "ASIA", secretAccessKey: "s", sessionToken: "tmp-token" });
      await new FunctionRouter("aws", { endpoints: { "GET /x": "https://a.lambda-url.us-east-2.on.aws/" }, credentials: temporary })
        .url("GET", "/x", echo)
        .fetch(new Request("http://app/x"));
      expect(seen[0]!.headers.get("x-amz-security-token")).toBe("tmp-token");
    });

    test("auth: none sends no credentials", async () => {
      const seen = captureFetch();
      await new FunctionRouter("aws", { endpoints: { "GET /x": "https://a.lambda-url.us-east-2.on.aws/" }, authenticated: "none" })
        .url("GET", "/x", echo)
        .fetch(new Request("http://app/x"));
      expect(seen[0]!.headers.get("authorization")).toBeNull();
    });

    test("a URL outside lambda-url.* needs an explicit region", async () => {
      const log = spyOn(console, "error").mockImplementation(() => {});
      const saved = [process.env.AWS_REGION, process.env.AWS_DEFAULT_REGION];
      delete process.env.AWS_REGION;
      delete process.env.AWS_DEFAULT_REGION;
      try {
        captureFetch();
        const withoutRegion = new FunctionRouter("aws", { endpoints: { "GET /x": "https://fn.example.com/" }, credentials }).url("GET", "/x", echo);
        expect((await withoutRegion.fetch(new Request("http://app/x"))).status).toBe(502);

        const seen = captureFetch();
        const withRegion = new FunctionRouter("aws", { endpoints: { "GET /x": "https://fn.example.com/" }, credentials, region: "ap-south-1" }).url("GET", "/x", echo);
        await withRegion.fetch(new Request("http://app/x"));
        expect(seen[0]!.headers.get("authorization")).toContain("/ap-south-1/lambda/aws4_request");
      } finally {
        log.mockRestore();
        if (saved[0] !== undefined) process.env.AWS_REGION = saved[0];
        if (saved[1] !== undefined) process.env.AWS_DEFAULT_REGION = saved[1];
      }
    });

    test("regionFromUrl reads function URL hosts only", () => {
      expect(regionFromUrl("https://x.lambda-url.us-west-2.on.aws/")).toBe("us-west-2");
      expect(regionFromUrl("https://fn.example.com/")).toBeUndefined();
    });
  });

  describe("endpoints file", () => {
    const dirs: string[] = [];
    const originalCwd = process.cwd();
    afterEach(() => {
      process.chdir(originalCwd);
      while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    });
    const projectWith = (file: object) => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-endpoints-")));
      dirs.push(dir);
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
      fs.mkdirSync(path.join(dir, ".cloudgear"));
      fs.writeFileSync(path.join(dir, ".cloudgear", "endpoints.json"), JSON.stringify(file));
      fs.mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
      return dir;
    };

    test("is found from a nested working directory", () => {
      const dir = projectWith({ provider: "aws", routes: { "GET /x": "https://fn" }, auth: "iam" });
      process.chdir(path.join(dir, "src", "deep"));
      const router = new FunctionRouter("aws").url("GET", "/x", echo);
      expect(router.mode).toBe("remote");
    });

    test("is not taken from a parent project that has its own package.json", () => {
      const parent = projectWith({ provider: "aws", routes: { "GET /x": "https://other-project" } });
      const child = path.join(parent, "child");
      fs.mkdirSync(child);
      fs.writeFileSync(path.join(child, "package.json"), "{}");
      process.chdir(child);
      expect(new FunctionRouter("aws").url("GET", "/x", echo).mode).toBe("local");
    });

    test("its auth setting decides whether calls are signed", async () => {
      const original = globalThis.fetch;
      const seen: (string | null)[] = [];
      globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        seen.push(new Headers(init.headers).get("authorization"));
        return new Response("{}");
      }) as typeof fetch;
      try {
        const dir = projectWith({ provider: "aws", routes: { "GET /x": "https://a.lambda-url.us-east-1.on.aws/" }, auth: "none" });
        process.chdir(dir);
        await new FunctionRouter("aws").url("GET", "/x", echo).fetch(new Request("http://app/x"));
      } finally {
        globalThis.fetch = original;
      }
      expect(seen).toEqual([null]);
    });

    test("with no routes (after destroy) the router stays local", () => {
      const dir = projectWith({ provider: "aws", routes: {} });
      process.chdir(dir);
      expect(new FunctionRouter("aws").url("GET", "/x", echo).mode).toBe("local");
    });

    test("rejects a file deployed for another provider", () => {
      const dir = projectWith({ provider: "gcp", routes: { "GET /x": "https://fn" } });
      process.chdir(dir);
      expect(() => new FunctionRouter("aws").mode).toThrow(/deployed for provider "gcp"/);
    });
  });

  test("an empty CLOUDGEAR_ENDPOINTS means local mode", () => {
    process.env.CLOUDGEAR_ENDPOINTS = "{}";
    try {
      expect(new FunctionRouter("aws", { endpointsFile: "/nonexistent" }).mode).toBe("local");
    } finally {
      delete process.env.CLOUDGEAR_ENDPOINTS;
    }
  });

  test("reads endpoints from CLOUDGEAR_ENDPOINTS", () => {
    process.env.CLOUDGEAR_ENDPOINTS = JSON.stringify({ "GET /x": "https://example" });
    try {
      expect(new FunctionRouter("aws").url("GET", "/x", echo).mode).toBe("remote");
    } finally {
      delete process.env.CLOUDGEAR_ENDPOINTS;
    }
  });

  test("defaults to local mode without an endpoints file", () => {
    expect(new FunctionRouter("aws", { endpointsFile: "/nonexistent/endpoints.json" }).mode).toBe("local");
  });
});

describe("aws createHandler", () => {
  const handler = createHandler(echo, [{ method: "GET", path: "/items/{id}" }]);
  const event = (overrides: Partial<FunctionUrlEvent>): FunctionUrlEvent => ({
    rawPath: "/",
    requestContext: { http: { method: "POST" } },
    ...overrides,
  });

  test("uses the router's invoke body as the input verbatim", async () => {
    const res = await handler(
      event({ headers: { "Content-Type": INVOKE_CONTENT_TYPE }, body: JSON.stringify({ id: "1", extra: true }) }),
    );
    expect(JSON.parse(res.body)).toEqual({ id: "1", extra: true });
  });

  test("builds the input from a direct HTTP call", async () => {
    const res = await handler(
      event({ rawPath: "/items/5", rawQueryString: "verbose=1", requestContext: { http: { method: "GET" } } }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ verbose: "1", id: "5" });
  });

  test("decodes base64 bodies", async () => {
    const res = await handler(
      event({
        headers: { "content-type": INVOKE_CONTENT_TYPE },
        body: Buffer.from(JSON.stringify({ id: "b64" })).toString("base64"),
        isBase64Encoded: true,
      }),
    );
    expect(JSON.parse(res.body)).toEqual({ id: "b64" });
  });

  test("404 for direct calls that match no route, 400 for malformed JSON", async () => {
    expect((await handler(event({ rawPath: "/other" }))).statusCode).toBe(404);
    expect((await handler(event({ headers: { "content-type": INVOKE_CONTENT_TYPE }, body: "{" }))).statusCode).toBe(400);
  });
});
