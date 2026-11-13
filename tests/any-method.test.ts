import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FunctionRouter, VercelResponse } from "@cloudgear/functions";
import { createHandler } from "../packages/functions/drivers/aws";
import { analyzeApp } from "../src/analyze/app";
import { endpointsFrom } from "../src/deploy/apply";
import { routeFunctionCode } from "../src/deploy/aws/route-function";
import { plan, type CdnComparable } from "../src/deploy/plan";
import { generate } from "../src/generate";
import { behaviorsFor, conflictingGroups } from "../src/routes";
import { applyAll, baseConfig, emptyState, fakeAws, fn } from "./helpers";
import type { CloudgearConfig } from "../src/config/schema";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "anymethod", name);

const DOMAIN = "api.example.com";
const dnsSpec = { provider: "gandi", domain: DOMAIN, zone: "example.com" };
const ALL_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"];

describe("analyzing the method *", () => {
  test("a * route to a script with include, request, response and env is accepted", () => {
    const model = analyzeApp(fixture("main.ts"));
    expect(model.functions).toHaveLength(1);
    expect(model.functions[0]).toMatchObject({
      name: "api-index",
      passRequest: true,
      responseKind: "writer",
      routes: [{ method: "*", path: "/", name: "* /" }],
    });
    expect(model.functions[0]!.include.map((f) => f.rel)).toEqual(["dist/index.html"]);
    expect(model.functions[0]!.secrets.map((s) => s.env)).toEqual(["A"]);
  });

  test("an unknown method is refused, and the message offers *", () => {
    expect(() => analyzeApp(fixture("bad-method.ts"))).toThrow(/unsupported HTTP method "FOO", expected one of GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS or "\*"/);
  });

  test("* twice on one path is a duplicate", () => {
    expect(() => analyzeApp(fixture("duplicate.ts"))).toThrow(/route "\* \/x" is registered twice/);
  });

  test("* and GET on one path are not duplicates", () => {
    const model = analyzeApp(fixture("coexist.ts"));
    expect(model.functions.flatMap((f) => f.routes.map((r) => `${r.method} ${r.path}`)).sort()).toEqual(["* /x", "GET /x"]);
  });

  test("generate writes the * route into the config", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-any-"));
    try {
      const { config } = await generate({ entry: fixture("main.ts"), configPath: path.join(dir, "cloudgear.prototxt"), buildDir: path.join(dir, "build") });
      expect(config.function.map((f) => f.route)).toEqual([[{ method: "*", path: "/", name: "* /" }]]);
      expect(fs.readFileSync(path.join(dir, "cloudgear.prototxt"), "utf8")).toContain('method: "*"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a * route in local mode", () => {
  const serve = (order: "specific-first" | "any-first" = "specific-first") => {
    const router = new FunctionRouter("aws", { mode: "local" });
    const any = () => router.url("*", "/x", async () => ({ via: "any" }), { name: "any" });
    const get = () => router.url("GET", "/x", async () => ({ via: "get" }), { name: "get" });
    if (order === "specific-first") get();
    any();
    if (order === "any-first") get();
    return router;
  };

  test("GET, POST, DELETE and HEAD all reach it, and no method answers 405", async () => {
    const router = new FunctionRouter("aws", { mode: "local" }).url("*", "/x/{id}", async (input: { id: string }) => ({ id: input.id }), { name: "any" });
    for (const method of ["GET", "POST", "DELETE", "OPTIONS", "PATCH"]) {
      const res = await router.fetch(new Request("http://localhost/x/7", { method }));
      expect([method, res.status]).toEqual([method, 200]);
      expect(await res.json()).toEqual({ id: "7" });
    }
    const head = await router.fetch(new Request("http://localhost/x/7", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect((await router.fetch(new Request("http://localhost/y"))).status).toBe(404);
  });

  test.each(["specific-first", "any-first"] as const)("the specific method wins whatever the registration order (%s)", async (order) => {
    const router = serve(order);
    expect(await (await router.fetch(new Request("http://localhost/x"))).json()).toEqual({ via: "get" });
    expect(await (await router.fetch(new Request("http://localhost/x", { method: "POST" }))).json()).toEqual({ via: "any" });
    expect(await (await router.fetch(new Request("http://localhost/x", { method: "HEAD" }))).status).toBe(200);
  });

  test("* only matches its own path, not sub-paths", async () => {
    const router = new FunctionRouter("aws", { mode: "local" }).url("*", "/x", async () => ({}), { name: "any" });
    expect((await router.fetch(new Request("http://localhost/x/y"))).status).toBe(404);
  });

  test("the same route twice is refused, and * with GET is not", () => {
    expect(() => new FunctionRouter("aws").url("*", "/x", async () => ({}), { name: "a" }).url("*", "/x", async () => ({}), { name: "b" })).toThrow(/Route "\* \/x" is already registered/);
    expect(() => serve()).not.toThrow();
    expect(() => new FunctionRouter("aws").url("FOO" as "GET", "/x", async () => ({}))).toThrow(/Unsupported HTTP method "FOO", expected one of .* or "\*"/);
  });

  test("a script handles any method and sees the real one", async () => {
    const router = new FunctionRouter("aws", { mode: "local" }).url("*", "/", "./fixtures/router/anymethod/api/index.ts", { request: true, response: VercelResponse });
    const res = await router.fetch(new Request("http://localhost/?a=1", { method: "PUT" }));
    expect(await res.json()).toEqual({ method: "PUT", url: "/?a=1" });
  });
});

describe("router.fetch with a * route", () => {
  const realFetch = globalThis.fetch;
  let calls: { url: string; method: string }[];
  let router: FunctionRouter | undefined;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET" });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    router?.stop();
  });

  const serve = () => {
    router = new FunctionRouter("aws", { mode: "local" })
      .url("*", "/x", async () => ({}), { name: "any" })
      .url("POST", "/both", async () => ({}), { name: "post-both" })
      .url("*", "/both", async () => ({}), { name: "any-both" })
      .url("GET", "/only", async () => ({}), { name: "get-only" });
    router.listen(0);
    return router;
  };

  test("the path form defaults to GET and takes any method", async () => {
    const r = serve();
    await r.fetch("/x");
    await r.fetch("/x", { method: "PUT" });
    await r.fetch("/x?q=1", { method: "DELETE" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "DELETE"]);
  });

  test("a path with * and a specific method needs init.method unless the default is unambiguous", async () => {
    const r = serve();
    await expect(r.fetch("/both")).rejects.toThrow(/matches routes for POST, \*; pass init.method/);
    await r.fetch("/both", { method: "POST" });
    await r.fetch("/both", { method: "PATCH" });
    expect(calls.map((c) => c.method)).toEqual(["POST", "PATCH"]);
    await expect(r.fetch("/only", { method: "PUT" })).rejects.toThrow(/Method PUT is not allowed for "\/only"; allowed: GET/);
  });

  test("the name form of a * route sends GET unless a method is given", async () => {
    const r = serve();
    await r.fetch("any");
    await r.fetch("any", { method: "PUT", body: { a: 1 } });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
  });

  test("urls() and the endpoints file use the route key", () => {
    const r = serve();
    expect(Object.keys(r.urls())).toEqual(["any", "post-both", "any-both", "get-only"]);
    const unnamed = new FunctionRouter("aws", { mode: "local" }).url("*", "/z", async () => ({}));
    unnamed.listen(0);
    expect(Object.keys(unnamed.urls())).toEqual(["* /z"]);
    unnamed.stop();
    const config = { ...baseConfig(), function: [fn({ route: [{ method: "*", path: "/z", name: "z" }] })] };
    const state = emptyState();
    state.entries["@aws.Lambda.foo"] = { type: "@aws.Lambda", name: "foo", physical_name: "app-foo", spec: {}, outputs: { url: "https://foo.example/" }, deps: [] } as never;
    expect(endpointsFrom(config, state).routes).toEqual({ "* /z": "https://foo.example/" });
  });

  test("in remote mode the endpoint of the * route is called with the requested method's route key", async () => {
    const remote = new FunctionRouter("aws", { mode: "remote", endpoints: { "* /x": "https://fn.example/" }, authenticated: "none" }).url("*", "/x", async () => ({}), { name: "any" });
    await remote.fetch("/x", { method: "PUT" });
    expect(calls[0]!.url).toBe("https://fn.example/");
    expect(calls[0]!.method).toBe("POST");
  });
});

describe("the Lambda handler with * routes", () => {
  const event = (method: string, rawPath = "/x") => ({
    rawPath,
    rawQueryString: "",
    headers: { host: "f.lambda-url.eu-west-1.on.aws" },
    body: "",
    isBase64Encoded: false,
    requestContext: { http: { method } },
  });

  test("every method reaches a * route, with HEAD handled by the function itself", async () => {
    const seen: string[] = [];
    const handler = createHandler(async (request: { method: string }) => (seen.push(request.method), { ok: true }), [{ method: "*", path: "/x" }], { request: true });
    for (const method of ["GET", "POST", "HEAD", "DELETE"]) expect((await handler(event(method))).statusCode).toBe(200);
    expect(seen).toEqual(["GET", "POST", "HEAD", "DELETE"]);
    expect((await handler(event("GET", "/other"))).statusCode).toBe(404);
  });
});

describe("planning * routes for API Gateway", () => {
  const apiConfig = (functions = [fn({ permission: [], env: [], route: [{ method: "*", path: "/x/{id}", name: "any" }, { method: "GET", path: "/x/{id}", name: "get" }] })]): CloudgearConfig => ({
    ...baseConfig(),
    resource: [],
    function: functions,
    certificate: [{ provider: "aws", domain: DOMAIN, dns: dnsSpec, usage: "api" }],
    api: { provider: "aws", domain: DOMAIN },
  });

  test("the route key is ANY /path, next to a specific method on the same path", () => {
    const spec = plan(apiConfig(), emptyState()).find((a) => a.key === `@aws.ApiGateway.${DOMAIN}`)!.desired!.spec as { routes: unknown[] };
    expect(spec.routes).toEqual([
      { key: "ANY /x/{id}", function: "app-foo" },
      { key: "GET /x/{id}", function: "app-foo" },
    ]);
  });

  test("apply creates ANY and GET routes", async () => {
    const created: string[] = [];
    const aws = fakeAws({
      RequestCertificateCommand: () => ({ CertificateArn: "arn:aws:acm:eu-west-1:1:certificate/api" }),
      GetIntegrationsCommand: () => ({ Items: [] }),
      CreateIntegrationCommand: () => ({ IntegrationId: "int-1" }),
      GetRoutesCommand: () => ({ Items: [] }),
      CreateRouteCommand: (input) => void created.push(input.RouteKey),
      GetDomainNameCommand: () => {
        throw Object.assign(new Error("none"), { name: "NotFoundException" });
      },
      CreateDomainNameCommand: (input) => ({ DomainNameConfigurations: [{ ...input.DomainNameConfigurations[0], ApiGatewayDomainName: "d-abc.execute-api.eu-west-1.amazonaws.com" }] }),
      GetApiMappingsCommand: () => ({ Items: [] }),
    });
    await applyAll(apiConfig(), emptyState(), aws);
    expect(created.sort()).toEqual(["ANY /x/{id}", "GET /x/{id}"]);
  });
});

describe("planning * routes for a CDN", () => {
  const cdnConfig = (functions: ReturnType<typeof fn>[], methodRouting = false): CloudgearConfig => ({
    ...baseConfig(),
    resource: [],
    function: functions,
    certificate: [{ provider: "aws", domain: DOMAIN, dns: dnsSpec, usage: "cdn" }],
    api: { provider: "aws", domain: DOMAIN, via: "cloudfront", ...(methodRouting ? { method_routing: true } : {}) },
  });
  const anyFn = fn({ name: "any", physical_name: "app-any", permission: [], env: [], route: [{ method: "*", path: "/x", name: "any" }] });
  const getFn = fn({ name: "get", physical_name: "app-get", permission: [], env: [], route: [{ method: "GET", path: "/x", name: "get" }] });

  test("the behavior of a * route allows every method", async () => {
    const config = cdnConfig([anyFn]);
    const spec = plan(config, emptyState()).find((a) => a.key === `@aws.CloudFront.${DOMAIN}`)!.desired!.spec as unknown as CdnComparable;
    expect(spec.behaviors).toEqual([{ pattern: "/x/", methods: ["*"], function: "app-any" }, { pattern: "/x", methods: ["*"], function: "app-any" }]);
    const aws = await applyAll(config, emptyState());
    const distribution = aws.of("CreateDistributionCommand")[0].DistributionConfig;
    expect(distribution.CacheBehaviors.Items.map((b: any) => b.AllowedMethods.Items)).toEqual([ALL_METHODS, ALL_METHODS]);
  });

  test("* and a specific method on one path, to different functions, are refused unless method routing is on", () => {
    expect(() => plan(cdnConfig([anyFn, getFn]), emptyState())).toThrow(/CloudFront cannot tell apart/);
    const spec = plan(cdnConfig([anyFn, getFn], true), emptyState()).find((a) => a.key === `@aws.CloudFront.${DOMAIN}`)!.desired!.spec as unknown as CdnComparable;
    expect(spec.method_routes).toEqual([
      { method: "*", path: "/x", function: "app-any" },
      { method: "GET", path: "/x", function: "app-get" },
    ]);
  });

  test("a * route in a param path covers a literal path only when that one accepts every method", () => {
    const route = (method: string, path: string, name: string) => ({ method, path, function: name });
    expect(conflictingGroups([route("*", "/a/{id}", "x"), route("GET", "/a/new", "y")]).length).toBe(1);
    expect(conflictingGroups([route("GET", "/a/{id}", "x"), route("*", "/a/new", "y")])).toEqual([]);
    expect(conflictingGroups([route("*", "/a/{id}", "x"), route("*", "/a/new", "y")])).toEqual([]);
    expect(behaviorsFor([route("*", "/a", "x")]).every((b) => b.methods.join() === "*")).toBe(true);
  });

  test("the routing function sends any method to a * route and lets a specific method win", () => {
    const selected: string[] = [];
    const source = routeFunctionCode([
      { method: "*", path: "/x", function: "any" },
      { method: "GET", path: "/x", function: "get" },
    ]).replace("import cf from 'cloudfront';", "const cf = { selectRequestOriginById: (id) => selected.push(id) };");
    const handler = new Function("selected", `${source}\nreturn handler;`)(selected) as (event: unknown) => any;
    for (const method of ["GET", "POST", "HEAD", "OPTIONS"]) handler({ request: { method, uri: "/x" } });
    expect(selected).toEqual(["cloudgear-fn-get", "cloudgear-fn-any", "cloudgear-fn-any", "cloudgear-fn-any"]);
    expect(handler({ request: { method: "GET", uri: "/x/y" } })).toMatchObject({ statusCode: 404 });
  });

  test("method routing with only a * route allows every method on the default behavior", async () => {
    const aws = await applyAll(cdnConfig([anyFn], true), emptyState());
    const distribution = aws.of("CreateDistributionCommand")[0].DistributionConfig;
    expect(distribution.DefaultCacheBehavior.AllowedMethods.Items).toEqual(ALL_METHODS);
  });
});
