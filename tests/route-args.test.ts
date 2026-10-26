import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import { FunctionRouter, response } from "@cloudgear/functions";
import { createHandler } from "../packages/functions/drivers/aws";
import { deserializeRequest, serializeRequest } from "../packages/functions/http";
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
      inputType: "{ slug: string }",
      passRequest: true,
      passResponse: true,
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
    ["bad-response.ts", /route response must be the `response` helper imported from @cloudgear\/functions/],
    ["bad-request.ts", /route request must be the literal true or false/],
    ["mixed.ts", /give it different include, request or response settings/],
    ["bad-root.ts", /include "\." must name a file or directory below the project root/],
    ["bad-reserved.ts", /include "index\.mjs" would replace the function's index\.mjs/],
    ["bad-link.ts", /include "linked" contains a symbolic link/],
    ["bad-escape.ts", /include "escape" resolves outside the project/],
    ["bad-generated.ts", /include ".cloudgear\/build" is generated output/],
    ["collide.ts", /Two functions are named "api-a-b"/],
    ["bad-lead.ts", /path param\(s\) "slug" missing from input type/],
  ])("rejects %s", (file, error) => {
    expect(() => analyzeApp(fixture(file))).toThrow(error);
  });
});

describe("the router in local mode", () => {
  const call = async (router: FunctionRouter, init?: RequestInit) => {
    const res = await router.fetch(new Request("http://localhost/v/hello?x=1", init));
    return { status: res.status, headers: res.headers, body: await res.json() };
  };

  test("passes the request, then the response helper, before the input", async () => {
    const router = new FunctionRouter("aws", { mode: "local" }).url("POST", "/v/{slug}", "./fixtures/router/vercel/api/echo.ts", { request: true, response });
    const res = await router.fetch(new Request("http://localhost/v/hello?x=1", { method: "POST", body: "payload" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-slug")).toBe("hello");
    expect(await res.json()).toEqual({ slug: "hello", method: "POST", path: "/v/hello", query: "?x=1", body: "payload", respond: "function" });
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

  test("a path from the project root reaches the same script", async () => {
    const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/v/{slug}", "tests/fixtures/router/vercel/api/echo.ts", { request: true, response });
    expect((await call(router)).body).toMatchObject({ slug: "hello", method: "GET" });
  });

  test("a function without the flags still gets only its input", async () => {
    const seen: unknown[][] = [];
    const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/v/{slug}", async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    await call(router);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(2);
    expect(seen[0]![0]).toMatchObject({ slug: "hello", x: "1" });
  });

  test("with only request, or only response, the other slot is left out", async () => {
    const seen: Record<string, unknown[]> = {};
    const record = (name: string) => async (...args: unknown[]) => ((seen[name] = args), {});
    const router = new FunctionRouter("aws", { mode: "local" })
      .url("GET", "/a/{id}", record("request"), { request: true })
      .url("GET", "/b/{id}", record("response"), { response });
    await router.fetch(new Request("http://localhost/a/1"));
    await router.fetch(new Request("http://localhost/b/1"));
    expect(seen.request![0]).toBeInstanceOf(Request);
    expect(seen.request![1]).toMatchObject({ id: "1" });
    expect(seen.response![0]).toBe(response);
    expect(seen.response![1]).toMatchObject({ id: "1" });
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

  test("builds the request from a direct call and passes the response helper after it", async () => {
    let args: unknown[] = [];
    const handler = createHandler(async (...a: unknown[]) => ((args = a), { ok: true }), routes, { request: true, response: true });
    const result = await handler(event());
    expect(result.statusCode).toBe(200);
    const [request, helper, input] = args as [Request, unknown, Record<string, unknown>];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://abc.lambda-url.eu-west-1.on.aws/v/hello?x=1");
    expect(request.headers.get("x-token")).toBe("t");
    expect(await request.text()).toBe("hi");
    expect(helper).toBe(response);
    expect(input).toMatchObject({ slug: "hello", x: "1" });
  });

  test("decodes a base64 body for the request", async () => {
    let seen = "";
    const handler = createHandler(async (request: Request) => ((seen = await request.text()), {}), routes, { request: true });
    await handler(event({ body: Buffer.from("binary-ish").toString("base64"), isBase64Encoded: true }));
    expect(seen).toBe("binary-ish");
  });

  test("uses the request the router forwarded in an invoke payload", async () => {
    let seen: Request | undefined;
    const handler = createHandler(async (request: Request) => ((seen = request), {}), routes, { request: true, trustContext: true });
    await handler(
      event({
        headers: { "content-type": "application/vnd.cloudgear.invoke+json", host: "fn.invalid" },
        body: JSON.stringify({
          input: { slug: "hello" },
          context: {},
          request: { method: "PUT", url: "https://api.example.com/v/hello", headers: { "x-original": "1" }, body: Buffer.from("orig").toString("base64") },
        }),
      }),
    );
    expect(seen!.method).toBe("PUT");
    expect(seen!.url).toBe("https://api.example.com/v/hello");
    expect(seen!.headers.get("x-original")).toBe("1");
    expect(await seen!.text()).toBe("orig");
  });

  test("ignores a forwarded request unless the function trusts the router", async () => {
    let seen: Request | undefined;
    const handler = createHandler(async (request: Request) => ((seen = request), {}), routes, { request: true });
    await handler(
      event({
        headers: { "content-type": "application/vnd.cloudgear.invoke+json", host: "real.example" },
        body: JSON.stringify({ input: {}, context: {}, request: { method: "GET", url: "https://forged.example/", headers: { authorization: "victim" } } }),
      }),
    );
    expect(seen!.url).toBe("https://real.example/v/hello?x=1");
    expect(seen!.headers.get("authorization")).toBeNull();
  });

  test("a malformed forwarded request falls back to the one received", async () => {
    let seen: Request | undefined;
    const handler = createHandler(async (request: Request) => ((seen = request), {}), routes, { request: true, trustContext: true });
    await handler(event({ headers: { "content-type": "application/vnd.cloudgear.invoke+json", host: "real.example" }, body: JSON.stringify({ input: {}, request: { method: 5 } }) }));
    expect(seen!.url).toBe("https://real.example/v/hello?x=1");
  });

  test("the cookies of a Function URL event become the cookie header", async () => {
    let seen: Request | undefined;
    const handler = createHandler(async (request: Request) => ((seen = request), {}), routes, { request: true });
    await handler(event({ cookies: ["a=1", "b=2"] }));
    expect(seen!.headers.get("cookie")).toBe("a=1; b=2");
  });

  test("a function without the flags gets only input and context", async () => {
    let count = -1;
    const handler = createHandler(async (...a: unknown[]) => ((count = a.length), {}), routes);
    await handler(event());
    expect(count).toBe(2);
  });

  test("a scheduled run gets a synthetic request in the request slot", async () => {
    let first: unknown;
    const handler = createHandler(async (...a: unknown[]) => ((first = a[0]), {}), routes, { request: true });
    await handler({ source: "aws.events", time: "2026-01-01T00:00:00Z" });
    expect(first).toBeInstanceOf(Request);
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
    const back = deserializeRequest(post);
    expect(back.method).toBe("POST");
    expect(await back.text()).toBe("payload");
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
      expect(only).toMatchObject({ name: "api-v-slug", include: ["dist/index.html"], pass_request: true, pass_response: true });
      const bundleDir = path.join(dir, "build", "api-v-slug");
      expect(fs.readFileSync(path.join(bundleDir, INCLUDED_DIR, "dist", "index.html"), "utf8")).toBe("<html>ok</html>\n");
      expect(fs.readFileSync(path.join(bundleDir, "entry.ts"), "utf8")).toContain("request: true, response: true");
      expect(hashBundle(path.join(bundleDir, "index.mjs"), path.join(bundleDir, INCLUDED_DIR), ["dist/index.html"])).toBe(only!.bundle.sha256);
      expect(hashBundle(path.join(bundleDir, "index.mjs"), path.join(bundleDir, INCLUDED_DIR), [])).not.toBe(only!.bundle.sha256);
      expect(decodeConfig(encodeConfig(config)).function[0]).toMatchObject({ include: ["dist/index.html"], pass_request: true, pass_response: true });
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
