import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FunctionRouter, INVOKE_CONTENT_TYPE, TOKEN_ENV, TOKEN_HEADER, response } from "@cloudgear/functions";
import { createHandler, type FunctionUrlEvent } from "@cloudgear/functions/aws";
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
    .add("POST", "/foo/{param}", (input: { name: string; param: string; q?: string }) => ({
      greeting: `${input.name}:${input.param}:${input.q}`,
      at: new Date(0),
    }))
    .add("GET", "/missing", () => response({ error: "nope" }, { status: 404, headers: { "x-test": "1" } }))
    .add("GET", "/boom", () => {
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
    const r = new FunctionRouter("aws", { mode: "local" }).add("POST", "/p/{id}", echo);
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
    const r = new FunctionRouter("aws").add("GET", "/a", echo);
    expect(() => r.add("get", "/a", echo)).toThrow(/already registered/);
    expect(() => r.add("TRACE" as "GET", "/b", echo)).toThrow(/Unsupported HTTP method/);
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
    const router = new FunctionRouter("aws", { endpoints: { "POST /foo/{param}": url } }).add(
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
    const router = new FunctionRouter("aws", { endpoints: {} }).add("GET", "/x", echo);
    expect((await router.fetch(new Request("http://app/x"))).status).toBe(502);
  });

  test("502 when the function URL is unreachable", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const router = new FunctionRouter("aws", { endpoints: { "GET /x": "http://127.0.0.1:1/" } }).add("GET", "/x", echo);
      const res = await router.fetch(new Request("http://app/x"));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "Function unreachable" });
    } finally {
      log.mockRestore();
    }
  });

  test("sends the invoke token, and the function rejects callers without it", async () => {
    process.env[TOKEN_ENV] = "s3cret";
    try {
      const url = fakeFunctionUrl(createHandler(echo, [{ method: "GET", path: "/x" }]));
      const good = new FunctionRouter("aws", { endpoints: { "GET /x": url }, token: "s3cret" }).add("GET", "/x", echo);
      expect((await good.fetch(new Request("http://app/x?a=1"))).status).toBe(200);

      const wrong = new FunctionRouter("aws", { endpoints: { "GET /x": url }, token: "nope" }).add("GET", "/x", echo);
      expect((await wrong.fetch(new Request("http://app/x"))).status).toBe(403);

      const direct = await fetch(new URL("/x", url));
      expect(direct.status).toBe(403);
    } finally {
      delete process.env[TOKEN_ENV];
    }
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

    test("is found from a nested working directory and supplies the token", () => {
      const dir = projectWith({ provider: "aws", routes: { "GET /x": "https://fn" }, token: "t" });
      process.chdir(path.join(dir, "src", "deep"));
      const router = new FunctionRouter("aws").add("GET", "/x", echo);
      expect(router.mode).toBe("remote");
    });

    test("is not taken from a parent project that has its own package.json", () => {
      const parent = projectWith({ provider: "aws", routes: { "GET /x": "https://other-project" } });
      const child = path.join(parent, "child");
      fs.mkdirSync(child);
      fs.writeFileSync(path.join(child, "package.json"), "{}");
      process.chdir(child);
      expect(new FunctionRouter("aws").add("GET", "/x", echo).mode).toBe("local");
    });

    test("falls back to the token env var when the file has none", async () => {
      const dir = projectWith({ provider: "aws", routes: { "GET /x": "http://127.0.0.1:1/" } });
      process.chdir(dir);
      process.env[TOKEN_ENV] = "from-env";
      const sent: (string | null)[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        sent.push(new Headers(init.headers).get(TOKEN_HEADER));
        return new Response("{}");
      }) as typeof fetch;
      try {
        await new FunctionRouter("aws").add("GET", "/x", echo).fetch(new Request("http://app/x"));
      } finally {
        globalThis.fetch = original;
        delete process.env[TOKEN_ENV];
      }
      expect(sent).toEqual(["from-env"]);
    });

    test("with no routes (after destroy) the router stays local", () => {
      const dir = projectWith({ provider: "aws", routes: {} });
      process.chdir(dir);
      expect(new FunctionRouter("aws").add("GET", "/x", echo).mode).toBe("local");
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
      expect(new FunctionRouter("aws").add("GET", "/x", echo).mode).toBe("remote");
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

  test("with a token configured, only invoke calls presenting it are served", async () => {
    process.env[TOKEN_ENV] = "tok";
    try {
      const invoke = (headers: Record<string, string>) =>
        handler(event({ headers: { "content-type": INVOKE_CONTENT_TYPE, ...headers }, body: "{}" }));
      expect((await invoke({ [TOKEN_HEADER]: "tok" })).statusCode).toBe(200);
      expect((await invoke({})).statusCode).toBe(403);
      expect((await invoke({ [TOKEN_HEADER]: "tok2" })).statusCode).toBe(403);
      const direct = await handler(event({ rawPath: "/items/5", requestContext: { http: { method: "GET" } } }));
      expect(direct.statusCode).toBe(403);
    } finally {
      delete process.env[TOKEN_ENV];
    }
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
