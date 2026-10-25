import { afterEach, describe, expect, test } from "bun:test";
import { FunctionRouter, INVOKE_CONTENT_TYPE, response } from "@cloudgear/functions";
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

  test("turns thrown errors into 500s", async () => {
    const res = await router.fetch(new Request("http://app/boom"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "kaboom" });
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
