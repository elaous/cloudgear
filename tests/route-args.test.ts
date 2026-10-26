import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import { FunctionRouter, VercelResponse, response } from "@cloudgear/functions";
import { createHandler } from "../packages/functions/drivers/aws";
import { serializeRequest } from "../packages/functions/http";
import { analyzeApp } from "../src/analyze/app";
import { INCLUDED_DIR, hashBundle, includedPath } from "../src/build/bundle";
import { decodeConfig, encodeConfig } from "../src/config/schema";
import { generate } from "../src/generate";
import { applyAll, baseConfig, emptyState, fakeAws, fn } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "vercel", name);

describe("analyzing request, response and include", () => {
  test("a plain script named after its path gets the request, the response helper and its files", () => {
    const model = analyzeApp(fixture("main.ts"));
    expect(model.functions).toHaveLength(1);
    const [only] = model.functions;
    expect(only).toMatchObject({
      name: "api-v-slug",
      file: "tests/fixtures/router/vercel/api/v/[slug].ts",
      exportName: "default",
      inputType: undefined,
      passRequest: true,
      responseKind: "helper",
      routes: [{ method: "GET", path: "/v/{slug}", name: "GET /v/{slug}" }],
    });
    expect(only!.include.map((f) => f.rel)).toEqual(["dist/index.html"]);
  });

  test("a directory and a file inside it are included once, in path order", () => {
    expect(analyzeApp(fixture("many.ts")).functions[0]!.include.map((f) => f.rel)).toEqual(["dist/index.html"]);
  });

  test.each([
    ["bad-include.ts", /include "dist\/nope\.html" not found/],
    ["bad-outside.ts", /include "\.\.\/\.\.\/analyze\.test\.ts" is outside the project/],
    ["bad-response.ts", /route response must be `response` or `VercelResponse`, imported from @cloudgear\/functions/],
    ["bad-request.ts", /route request must be the literal true or false/],
    ["mixed.ts", /give it different include, request or response settings/],
    ["bad-root.ts", /include "\." must name a file or directory below the project root/],
    ["bad-reserved.ts", /include "index\.mjs" would replace the function's index\.mjs/],
    ["bad-link.ts", /include "linked" contains a symbolic link/],
    ["bad-escape.ts", /include "escape" resolves outside the project/],
    ["bad-generated.ts", /include ".cloudgear\/build" is generated output/],
    ["collide.ts", /Two functions are named "api-a-b"/],
  ])("rejects %s", (file, error) => {
    expect(() => analyzeApp(fixture(file))).toThrow(error);
  });
});

describe("the router in local mode", () => {
  const echo = "./fixtures/router/vercel/api/echo.ts";

  test("a function that asked for the request gets a Vercel-style one, then the response helper, then the context", async () => {
    const router = new FunctionRouter("aws", { mode: "local" }).url("POST", "/v/{slug}", echo, { request: true, response });
    const res = await router.fetch(new Request("http://localhost/v/hello?x=1", { method: "POST", body: JSON.stringify({ k: 1 }), headers: { "content-type": "application/json", cookie: "a=b" } }));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-slug")).toBe("hello");
    expect(await res.json()).toEqual({ slug: "hello", x: "1", method: "POST", url: "/v/hello?x=1", body: { k: 1 }, cookie: "b" });
  });

  test("a VercelResponse writer replaces the return value as the output", async () => {
    const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/w/{slug}", "./fixtures/router/vercel/api/writer.ts", { request: true, response: VercelResponse });
    const res = await router.fetch(new Request("http://localhost/w/hello"));
    expect(res.status).toBe(202);
    expect(res.headers.get("x-written")).toBe("yes");
    expect(await res.json()).toEqual({ slug: "hello" });
  });

  test("a path from the project root reaches the same script", async () => {
    const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/v/{slug}", "tests/fixtures/router/vercel/api/echo.ts", { request: true, response });
    expect(await (await router.fetch(new Request("http://localhost/v/hello"))).json()).toMatchObject({ slug: "hello", method: "GET" });
  });

  test("without the flags a function gets its input and the context", async () => {
    const seen: unknown[][] = [];
    const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/v/{slug}", async (...args: unknown[]) => (seen.push(args), {}));
    await router.fetch(new Request("http://localhost/v/hello?x=1"));
    expect(seen[0]).toHaveLength(2);
    expect(seen[0]![0]).toMatchObject({ slug: "hello", x: "1" });
  });

  test("with only the request, or only a response, the arguments are (request, context) and (input, response, context)", async () => {
    const seen: Record<string, unknown[]> = {};
    const record = (name: string) => async (...args: unknown[]) => ((seen[name] = args), {});
    const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/a/{id}", record("request"), { request: true }).url("GET", "/b/{id}", record("response"), { response });
    await router.fetch(new Request("http://localhost/a/1"));
    await router.fetch(new Request("http://localhost/b/1"));
    expect(seen.request).toHaveLength(2);
    expect(seen.request![0]).toMatchObject({ method: "GET", query: { id: "1" } });
    expect(seen.response).toHaveLength(3);
    expect(seen.response![0]).toMatchObject({ id: "1" });
    expect(seen.response![1]).toBe(response);
  });

  test("a script that fails to load, or has no default function, answers 500 with its own message", async () => {
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      const router = new FunctionRouter("aws", { mode: "local" })
        .url("GET", "/absent", "./fixtures/router/scripts/handlers/absent.ts")
        .url("GET", "/named", "./fixtures/router/scripts/handlers/named.ts");
      expect(await (await router.fetch(new Request("http://localhost/absent"))).json()).toEqual({ error: "Route script failed to load" });
      expect(await (await router.fetch(new Request("http://localhost/named"))).json()).toEqual({ error: "Route script has no default export function" });
    } finally {
      quiet.mockRestore();
    }
  });

  test("a script path that leaves the project is refused", () => {
    expect(() => new FunctionRouter("aws").url("GET", "/x", "/../../outside.ts")).toThrow(/leaves the project/);
  });

  test("a caller whose directory has spaces still resolves its scripts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear with space-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), '{ "name": "spaced" }');
      fs.writeFileSync(path.join(dir, "h.ts"), "export default () => ({ ok: true });");
      fs.writeFileSync(
        path.join(dir, "router.ts"),
        `import { FunctionRouter } from ${JSON.stringify(path.join(import.meta.dir, "..", "packages", "functions", "router.ts"))};\nexport const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/h", "/h.ts").url("GET", "/rel", "./h.ts");\n`,
      );
      const { router } = await import(path.join(dir, "router.ts"));
      for (const route of ["/h", "/rel"]) expect(await (await router.fetch(new Request(`http://localhost${route}`))).json()).toEqual({ ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("remote calls forward the original request for a route that asked for it", async () => {
    const original = globalThis.fetch;
    const sent: any[] = [];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}");
    }) as typeof fetch;
    try {
      const router = new FunctionRouter("aws", {
        endpoints: { "POST /v/{slug}": "https://a.lambda-url.us-east-1.on.aws/", "POST /plain": "https://b.lambda-url.us-east-1.on.aws/" },
        credentials: async () => ({ accessKeyId: "AKID", secretAccessKey: "secret" }),
      })
        .url("POST", "/v/{slug}", async () => ({}), { request: true })
        .url("POST", "/plain", async () => ({}));
      await router.fetch(new Request("http://localhost/v/hi?x=1", { method: "POST", headers: { "x-token": "t" }, body: "raw body" }));
      await router.fetch(new Request("http://localhost/plain", { method: "POST", body: "x" }));
    } finally {
      globalThis.fetch = original;
    }
    expect(sent[0].request).toMatchObject({ method: "POST", url: "http://localhost/v/hi?x=1", headers: { "x-token": "t" } });
    expect(Buffer.from(sent[0].request.body, "base64").toString()).toBe("raw body");
    expect(sent[1].request).toBeUndefined();
  });
});

describe("the Lambda adapter", () => {
  const event = (over: Record<string, unknown> = {}) => ({
    rawPath: "/v/hello",
    rawQueryString: "x=1",
    headers: { Host: "abc.lambda-url.eu-west-1.on.aws", "X-Token": "t", "Content-Type": "text/plain" },
    body: "hi",
    isBase64Encoded: false,
    requestContext: { http: { method: "POST" } },
    ...over,
  });
  const routes = [{ method: "POST" as const, path: "/v/{slug}" }];
  const invokeEvent = (payload: unknown, host = "real.example") =>
    event({ headers: { "content-type": "application/vnd.cloudgear.invoke+json", host }, body: JSON.stringify(payload) });

  test("builds the Vercel-style request from a direct call, then passes the response helper and the context", async () => {
    let args: any[] = [];
    const handler = createHandler(async (...a: unknown[]) => ((args = a), { ok: true }), routes, { request: true, response: "helper" });
    expect((await handler(event())).statusCode).toBe(200);
    const [request, helper, context] = args;
    expect(request).toMatchObject({ method: "POST", url: "/v/hello?x=1", query: { slug: "hello", x: "1" }, body: "hi" });
    expect(request.headers["x-token"]).toBe("t");
    expect(helper).toBe(response);
    expect(context).toEqual({});
  });

  test("a VercelResponse writer's output is the function's response", async () => {
    const handler = createHandler(async (_request: unknown, res: VercelResponse) => void res.status(201).json({ done: true }), routes, { request: true, response: "writer" });
    const result = await handler(event());
    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body)).toEqual({ done: true });
    expect(result.headers["content-type"]).toContain("application/json");
  });

  test("waits for a writer that is ended after the function returns", async () => {
    const handler = createHandler(async (_request: unknown, res: VercelResponse) => void setTimeout(() => res.json({ late: true }), 5), routes, { request: true, response: "writer" });
    const result = await handler(event());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ late: true });
  });

  test("binary bodies are base64 and Set-Cookie values stay separate", async () => {
    const handler = createHandler(
      async (_request: unknown, res: VercelResponse) => void res.setHeader("set-cookie", ["a=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT", "b=2"]).send(new Uint8Array([0xff, 0xfe, 0x00])),
      routes,
      { request: true, response: "writer" },
    );
    const result = await handler(event());
    expect(result.isBase64Encoded).toBe(true);
    expect(Buffer.from(result.body, "base64")).toEqual(Buffer.from([0xff, 0xfe, 0x00]));
    expect(result.cookies).toEqual(["a=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT", "b=2"]);
    expect(result.headers["set-cookie"]).toBeUndefined();
  });

  test("an untrusted invoke-typed call still gets its path params, and __proto__ in the query is harmless", async () => {
    let seen: any;
    const handler = createHandler(async (request: unknown) => ((seen = request), {}), routes, { request: true });
    await handler(invokeEvent({ input: {} }));
    expect(seen.query.slug).toBe("hello");
    await handler(event({ rawQueryString: "__proto__=a&__proto__=b" }));
    expect(Array.isArray(Object.getPrototypeOf(seen.query))).toBe(false);
    expect(({} as any)[0]).toBeUndefined();
  });

  test("parses a JSON body, repeated query keys and cookies", async () => {
    let seen: any;
    const handler = createHandler(async (request: unknown) => ((seen = request), {}), routes, { request: true });
    await handler(event({ rawQueryString: "k=1&k=2", headers: { "content-type": "application/json" }, body: '{"a":1}', cookies: ["a=1", "b=2"] }));
    expect(seen.body).toEqual({ a: 1 });
    expect(seen.query.k).toEqual(["1", "2"]);
    expect(seen.cookies).toEqual({ a: "1", b: "2" });
  });

  test("decodes a base64 body for the request", async () => {
    let seen: any;
    const handler = createHandler(async (request: unknown) => ((seen = request), {}), routes, { request: true });
    await handler(event({ body: Buffer.from("binary-ish").toString("base64"), isBase64Encoded: true }));
    expect(seen.body).toBe("binary-ish");
  });

  test("uses the request the router forwarded in an invoke payload", async () => {
    let seen: any;
    const handler = createHandler(async (request: unknown) => ((seen = request), {}), routes, { request: true, trustContext: true });
    await handler(invokeEvent({ input: { slug: "hello" }, context: {}, request: { method: "POST", url: "https://api.example.com/v/hello?y=2", headers: { "x-original": "1" }, body: Buffer.from("orig").toString("base64") } }, "fn.invalid"));
    expect(seen).toMatchObject({ method: "POST", url: "/v/hello?y=2", query: { slug: "hello", y: "2" }, body: "orig" });
    expect(seen.headers["x-original"]).toBe("1");
  });

  test("ignores a forwarded request unless the function trusts the router", async () => {
    let seen: any;
    const handler = createHandler(async (request: unknown) => ((seen = request), {}), routes, { request: true });
    await handler(invokeEvent({ input: {}, context: {}, request: { method: "GET", url: "https://forged.example/forged", headers: { authorization: "victim" } } }));
    expect(seen.url).toBe("/v/hello?x=1");
    expect(seen.headers.authorization).toBeUndefined();
  });

  test("a malformed forwarded request falls back to the one received", async () => {
    let seen: any;
    const handler = createHandler(async (request: unknown) => ((seen = request), {}), routes, { request: true, trustContext: true });
    await handler(invokeEvent({ input: {}, request: { method: 5 } }));
    expect(seen.url).toBe("/v/hello?x=1");
  });

  test("a function without the flags gets only input and context", async () => {
    let count = -1;
    const handler = createHandler(async (...a: unknown[]) => ((count = a.length), {}), routes);
    await handler(event());
    expect(count).toBe(2);
  });

  test("a scheduled run gets a synthetic request whose body is the schedule input", async () => {
    let first: any;
    const handler = createHandler(async (...a: unknown[]) => ((first = a[0]), {}), routes, { request: true });
    await handler({ source: "aws.events", time: "2026-01-01T00:00:00Z" });
    expect(first.body).toEqual({ scheduledTime: "2026-01-01T00:00:00Z" });
  });
});

describe("forwarding a request", () => {
  test("a body-less request has no body, a bodied one round trips, hop-by-hop headers are dropped", async () => {
    const get = await serializeRequest(new Request("https://a.example/x?y=1", { headers: { "x-a": "1" } }));
    expect(get).toEqual({ method: "GET", url: "https://a.example/x?y=1", headers: { "x-a": "1" } });
    const head = await serializeRequest(new Request("https://a.example/x", { method: "HEAD" }));
    expect(head.body).toBeUndefined();
    const post = await serializeRequest(new Request("https://a.example/x", { method: "POST", body: "payload", headers: { connection: "close" } }));
    expect(post.headers.connection).toBeUndefined();
    expect(Buffer.from(post.body!, "base64").toString()).toBe("payload");
  });

  test("an included file path from a config cannot leave the files directory", () => {
    expect(includedPath("/build/files", "dist/index.html")).toBe("/build/files/dist/index.html");
    for (const bad of ["../x", "/etc/passwd", "dist/../../x", ""]) expect(() => includedPath("/build/files", bad)).toThrow(/outside the function's files/);
  });
});

describe("generating and deploying included files", () => {
  test("copies the files beside the bundle, hashes them with it, and records the settings", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-include-"));
    try {
      const { config } = await generate({ entry: fixture("main.ts"), configPath: path.join(dir, "cloudgear.prototxt"), buildDir: path.join(dir, "build") });
      const [only] = config.function;
      expect(only).toMatchObject({ name: "api-v-slug", include: ["dist/index.html"], pass_request: true, response_arg: "helper" });
      const bundleDir = path.join(dir, "build", "api-v-slug");
      expect(fs.readFileSync(path.join(bundleDir, INCLUDED_DIR, "dist", "index.html"), "utf8")).toBe("<html>ok</html>\n");
      expect(fs.readFileSync(path.join(bundleDir, "entry.ts"), "utf8")).toContain('request: true, response: "helper"');
      expect(hashBundle(path.join(bundleDir, "index.mjs"), path.join(bundleDir, INCLUDED_DIR), ["dist/index.html"])).toBe(only!.bundle.sha256);
      expect(hashBundle(path.join(bundleDir, "index.mjs"), path.join(bundleDir, INCLUDED_DIR), [])).not.toBe(only!.bundle.sha256);
      expect(decodeConfig(encodeConfig(config)).function[0]).toMatchObject({ include: ["dist/index.html"], pass_request: true, response_arg: "helper" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the function package holds the included files next to index.mjs", async () => {
    const aws = fakeAws();
    const config = baseConfig({ function: [{ ...fn(), include: ["dist/index.html", "data/a.json"] }] });
    await applyAll(config, emptyState(), aws);
    const zipFile = Buffer.from(aws.of("CreateFunctionCommand").find((i) => i.Code)!.Code.ZipFile);
    for (const name of ["index.mjs", "dist/index.html", "data/a.json"]) expect(zipFile.includes(Buffer.from(name))).toBe(true);
  });
});
