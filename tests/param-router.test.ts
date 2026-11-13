import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FunctionRouter, ParamRouter, VercelResponse } from "@cloudgear/functions";
import { analyzeApp } from "../src/analyze/app";
import { generate } from "../src/generate";

setDefaultTimeout(40_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "paramrouter", name);
const root = path.join(import.meta.dir, "..");
const dispatchDir = path.join(root, ".cloudgear", "dispatch");

describe("a ParamRouter at run time", () => {
  const router = () =>
    new FunctionRouter("aws", { mode: "local" }).url(
      "*",
      "/v1",
      new ParamRouter({
        "GET /items": { script: "./fixtures/router/paramrouter/api/items.ts" },
        "GET /items/{id}": { script: "./fixtures/router/paramrouter/api/item.ts" },
        "POST /items": { script: "./fixtures/router/paramrouter/api/create.ts" },
      }),
      { request: true, response: VercelResponse },
    );

  test("routes by method and path below the mount, with path params", async () => {
    const app = router();
    const items = await app.fetch(new Request("http://app/v1/items"));
    expect(await items.json()).toMatchObject({ route: "items" });
    expect(await (await app.fetch(new Request("http://app/v1/items/42"))).json()).toEqual({ route: "item", id: "42" });
    const created = await app.fetch(new Request("http://app/v1/items", { method: "POST" }));
    expect(created.status).toBe(201);
    expect((await app.fetch(new Request("http://app/items"))).status).toBe(404);
    expect((await app.fetch(new Request("http://app/v1/items/42", { method: "POST" }))).status).toBe(405);
  });

  test("urls() names every route, by its method and path", () => {
    const app = router();
    app.listen(0);
    try {
      expect(Object.keys(app.urls()).sort()).toEqual(["GET /v1/items", "GET /v1/items/{id}", "POST /v1/items"]);
    } finally {
      app.stop();
    }
  });

  test("the method \"*\" is for a ParamRouter only", () => {
    expect(() => new FunctionRouter("aws").url("*", "/", "./x.ts" as never)).toThrow(/only for a ParamRouter/);
    expect(() => new FunctionRouter("aws").url("GET" as never, "/", new ParamRouter({}))).toThrow(/mounted with the method "\*"/);
    expect(() => new FunctionRouter("aws").url("*", "/", new ParamRouter({ "FETCH /x": { script: "./x.ts" } }))).toThrow(/Unsupported HTTP method/);
  });
});

describe("a ParamRouter in the analyzer", () => {
  test("becomes one function with every route, and sees the env its scripts read", () => {
    const model = analyzeApp(fixture("app.ts"));
    expect(model.functions.map((f) => f.name)).toEqual(["api"]);
    const fn = model.functions[0]!;
    expect(fn.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /items", "GET /items/{id}", "POST /items"]);
    expect(fn).toMatchObject({ passRequest: true, responseKind: "writer", file: expect.stringMatching(/\.cloudgear[\\/]dispatch[\\/]api\.ts$/) });
    expect(Object.keys(fn.envUse.variables).sort()).toEqual(["CREATE_KEY", "ITEMS_DB"]);
    expect(model.generated).toHaveLength(1);
    expect(model.generated[0]!.text).toContain('import("../../tests/fixtures/router/paramrouter/api/items.ts")');
  });

  test("a route mounted by it sits beside ordinary routes, under the mount path, and unions the includes", () => {
    const model = analyzeApp(fixture("mixed.ts"));
    expect(model.functions.map((f) => [f.name, f.routes.map((r) => `${r.method} ${r.path}`)])).toEqual([
      ["health", ["GET /health"]],
      ["router", ["GET /v1/items", "POST /v1/items"]],
    ]);
    expect(model.functions[1]!.include.map((f) => f.rel)).toEqual([expect.stringMatching(/api\/item\.ts$/)]);
  });

  test.each([
    ["no-request.ts", /a ParamRouter needs request: true/],
    ["bad-key.ts", /Unsupported HTTP method "FETCH"/],
    ["missing-script.ts", /script "\.\/api\/nope\.ts" not found/],
  ])("rejects %s", (file, error) => {
    expect(() => analyzeApp(fixture(file))).toThrow(error);
  });
});

describe("a ParamRouter deployed as one function", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "param-router-"));
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(dispatchDir, "api.ts"), { force: true });
  });

  test("the bundle answers each route with its own script", async () => {
    const configPath = path.join(dir, "cloudgear.prototxt");
    await generate({ entry: fixture("app.ts"), configPath, buildDir: path.join(dir, "build"), project: "app" });
    const { handler } = await import(path.join(dir, "build", "api", "index.mjs"));
    const call = async (method: string, rawPath: string) =>
      handler({ rawPath, rawQueryString: "", headers: {}, requestContext: { http: { method } } }) as Promise<{ statusCode: number; body: string }>;
    const items = await call("GET", "/items");
    expect(items.statusCode).toBe(200);
    expect(JSON.parse(items.body)).toMatchObject({ route: "items" });
    expect(JSON.parse((await call("GET", "/items/42")).body)).toEqual({ route: "item", id: "42" });
    expect((await call("POST", "/items")).statusCode).toBe(201);
    expect((await call("GET", "/nope")).statusCode).toBe(404);
  });
});
