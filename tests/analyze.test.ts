import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeApp } from "../src/analyze/app";
import { decodeConfig } from "../src/config/schema";
import { generate } from "../src/generate";

const exampleDir = path.join(import.meta.dir, "..", "examples", "router-app");
const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", name);
const accesses = (uses: Map<string, { resource: string; path: string; accesses: Set<string> }>) =>
  Object.fromEntries([...uses.values()].map((use) => [use.path ? `${use.resource}:${use.path}` : use.resource, [...use.accesses].sort()]));

describe("analyzeApp", () => {
  test("infers routes, resources, directives and per-function usage for the example app", () => {
    const model = analyzeApp(path.join(exampleDir, "main.ts"));

    expect(model.provider).toBe("aws");
    expect(model.resources.map(({ name, dry }) => ({ name, dry }))).toEqual([
      { name: "myblob", dry: true },
      { name: "cloudgear-example-archive", dry: false },
    ]);
    expect(
      model.functions.map((f) => ({ name: f.name, routes: f.routes, inputType: f.inputType, uses: accesses(f.uses) })),
    ).toEqual([
      {
        name: "foo",
        routes: [{ method: "POST", path: "/foo/{param}", name: "createFoo" }],
        inputType: "types.FooInput",
        // archive is only reached through the archiveEvent helper
        uses: { myblob: ["write"], "cloudgear-example-archive": ["write"] },
      },
      { name: "getFoo", routes: [{ method: "GET", path: "/foo/{param}", name: "getFoo" }], inputType: "types.GetFooInput", uses: { myblob: ["read"] } },
      { name: "health", routes: [{ method: "GET", path: "/health", name: "health" }], inputType: undefined, uses: {} },
    ]);
    expect(model.warnings).toEqual([]);
  });

  test("handles aliased imports, leading directives, a router variable and escaping stores", () => {
    const model = analyzeApp(fixture("escaping-store.ts"));

    expect(model.resources).toMatchObject([{ name: "shared", dry: true }]);
    const byName = Object.fromEntries(model.functions.map((f) => [f.name, f]));
    expect(accesses(byName.listAll!.uses)).toEqual({ shared: ["delete", "list", "read", "write"] });
    expect(accesses(byName.check!.uses)).toEqual({ shared: ["list", "read"] });
    expect(byName.check!.routes).toEqual([
      { method: "GET", path: "/check/{key}", name: "check" },
      { method: "HEAD", path: "/check/{key}", name: "checkHead" },
    ]);
    expect(model.warnings).toEqual([expect.stringMatching(/"shared" is passed around as a value/)]);
  });

  test("reads authentication and route names from the router calls", () => {
    expect(analyzeApp(path.join(exampleDir, "main.ts"))).toMatchObject({ authenticated: "iam", warnings: [] });

    const open = analyzeApp(fixture("authenticated-none.ts"));
    expect(open.authenticated).toBe("none");
    expect(open.warnings).toEqual([expect.stringMatching(/authenticated is "none"; deployed functions can be invoked by anyone/)]);
    expect(open.functions[0]!.routes).toEqual([{ method: "GET", path: "/open", name: "open" }]);
  });

  test("routes can be methods of an exported object, and stores can be confined to a path", () => {
    const model = analyzeApp(fixture("object-exports.ts"));
    const byName = Object.fromEntries(model.functions.map((f) => [f.name, f]));
    expect(Object.keys(byName)).toEqual(["getObjects", "put"]);
    expect(byName.getObjects).toMatchObject({ exportName: "local", member: "getObjects" });
    expect(byName.put).toMatchObject({ exportName: "local", member: "put" });
    expect(accesses(byName.getObjects!.uses)).toEqual({ "objects:img-cache/": ["read"] });
    expect(accesses(byName.put!.uses)).toEqual({ "objects:img-cache/": ["write"] });
    expect(byName.put!.routes).toEqual([{ method: "PUT", path: "/objects/{param}", name: "putObject" }]);
    expect(model.resources.map((r) => r.name)).toEqual(["objects"]);
  });

  test("two stores on one bucket keep separate paths", () => {
    const model = analyzeApp(fixture("two-paths.ts"));
    expect(model.resources.map((r) => r.name)).toEqual(["shared"]);
    const byName = Object.fromEntries(model.functions.map((f) => [f.name, accesses(f.uses)]));
    expect(byName).toEqual({ readImage: { "shared:images/": ["read"] }, writeDoc: { "shared:docs/": ["write"] } });
  });

  test("grant() narrows a store that is otherwise passed around as a value", () => {
    const model = analyzeApp(fixture("grant-escape.ts"));
    const byName = Object.fromEntries(model.functions.map((f) => [f.name, accesses(f.uses)]));
    expect(byName.viaRepo).toEqual({ granted: ["read"] });
    expect(byName.widened).toEqual({ granted: ["delete", "list", "read", "write"] });
    expect(model.warnings).toHaveLength(1);
    expect(model.warnings[0]).toMatch(/passed around as a value; granting every operation on it \(use grant/);
  });

  test("follows .url chains through intermediate variables", () => {
    const model = analyzeApp(fixture("chained-variables.ts"));
    expect(model.functions.map((f) => f.routes[0]!.path)).toEqual(["/a", "/b", "/c"]);
  });

  test("follows a router defined in one module and populated in another", () => {
    const model = analyzeApp(fixture("split/main.ts"));
    expect(model.functions.map((f) => [f.name, f.routes])).toEqual([["hello", [{ method: "GET", path: "/hello", name: "hello" }]]]);
  });

  test("traces class methods, object methods and variable aliases", () => {
    const model = analyzeApp(fixture("indirect-usage.ts"));
    const uses = Object.fromEntries(model.functions.map((f) => [f.name, accesses(f.uses)]));
    expect(uses).toEqual({
      viaClass: { indirect: ["write"] },
      viaObject: { logs: ["delete"] },
      // an alias hands the store around as a value, so every access is granted
      viaAlias: { indirect: ["delete", "list", "read", "write"] },
      // Object.prototype members are not store operations
      inherited: { indirect: [] },
    });
    expect(model.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/"indirect" is used outside any function/),
        expect.stringMatching(/"indirect" is passed around as a value/),
      ]),
    );
  });

  test.each([
    ["authenticated-variable.ts", /authenticated must be a string literal/],
    ["authenticated-invalid.ts", /authenticated must be the literal "iam" or "none"/],
    ["options-spread.ts", /spread in FunctionRouter options cannot be analyzed/],
    ["options-variable.ts", /FunctionRouter options must be an object literal/],
    ["duplicate-route-names.ts", /route name "same" is already used by GET \/a/],
    ["route-name-variable.ts", /route name must be a string literal/],
    ["unexported-object.ts", /must be exported so it can be bundled on its own \(a named function, or a method of an exported object\)/],
    ["grant-unknown-access.ts", /unknown access "execute" in grant\(\)/],
    ["grant-empty.ts", /grant\(store, \.\.\.\) needs at least one access/],
    ["store-path-invalid.ts", /Invalid blob path "a\/\.\.\/b"/],
    ["store-path-variable.ts", /BlobStore path must be a string literal/],
    ["router-escapes.ts", /router is used in a way cloudgear cannot trace/],
    ["default-export.ts", /export the router with a name/],
    ["no-routes.ts", /FunctionRouter has no \.url\(\.\.\.\) routes/],
    ["unexported.ts", /must be exported/],
    ["inline.ts", /must reference a named function/],
    ["missing-param.ts", /path param\(s\) "other" missing from input type/],
    ["unknown-directive.ts", /unknown cloudgear directive "dyr"/],
    ["two-routers.ts", /Only one FunctionRouter per app/],
  ])("rejects %s", (file, error) => {
    expect(() => analyzeApp(fixture(file))).toThrow(error);
  });
});

describe("generate", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-generate-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("writes the prototxt and a runnable bundle per function", async () => {
    const configPath = path.join(dir, "cloudgear.prototxt");
    await generate({
      entry: path.join(exampleDir, "main.ts"),
      configPath,
      buildDir: path.join(dir, ".cloudgear", "build"),
      project: "demo",
    });
    const config = decodeConfig(fs.readFileSync(configPath, "utf8"));

    expect(config.project).toBe("demo");
    expect(config.authenticated).toBe("iam");
    expect(config.resource).toMatchObject([
      { name: "myblob", type: "@aws.S3", dry: true },
      { name: "cloudgear-example-archive", type: "@aws.S3", dry: false },
    ]);
    const foo = config.function.find((f) => f.name === "foo")!;
    expect(foo).toMatchObject({
      type: "@aws.Lambda",
      physical_name: "demo-foo",
      runtime: "nodejs22.x",
      source: { export: "foo", input_type: "types.FooInput" },
      bundle: { path: ".cloudgear/build/foo/index.mjs" },
      permission: [
        { resource: "myblob", action: ["s3:PutObject"] },
        { resource: "cloudgear-example-archive", action: ["s3:PutObject"] },
      ],
      env: [
        { key: "CLOUDGEAR_BLOB_MYBLOB", value_from: "myblob" },
        { key: "CLOUDGEAR_BLOB_CLOUDGEAR_EXAMPLE_ARCHIVE", value_from: "cloudgear-example-archive" },
      ],
    });
    expect(foo.bundle.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The bundle must run on plain Node, the Lambda runtime, with no node_modules beside it.
    const script = `
      const { handler } = await import(${JSON.stringify(path.join(dir, ".cloudgear/build/getFoo/index.mjs"))});
      const res = await handler({ rawPath: "/foo/7", requestContext: { http: { method: "GET" } }, headers: {} });
      console.log(JSON.stringify(res));
    `;
    const proc = Bun.spawnSync(["node", "--input-type=module", "-e", script], {
      env: { ...process.env, CLOUDGEAR_BLOB_DRIVER: "memory" },
      cwd: dir,
    });
    expect(proc.stderr.toString()).toBe("");
    expect(JSON.parse(proc.stdout.toString())).toEqual({
      statusCode: 404,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "not found" }),
    });
  });

  test("rejects invalid invokers and reserved concurrency", async () => {
    const base = { entry: path.join(exampleDir, "main.ts"), configPath: path.join(dir, "i.prototxt"), buildDir: path.join(dir, "b") };
    await expect(generate({ ...base, invokers: ["nope"] })).rejects.toThrow(/Invalid invoker "nope"/);
    await expect(generate({ ...base, reservedConcurrency: -1 })).rejects.toThrow(/Invalid reserved concurrency/);
    await expect(generate({ ...base, reservedConcurrency: 1.5 })).rejects.toThrow(/Invalid reserved concurrency/);
  });

  test("rejects functions whose sanitized names collide", async () => {
    await expect(
      generate({ entry: fixture("name-collision.ts"), configPath: path.join(dir, "z.prototxt"), buildDir: path.join(dir, "b") }),
    ).rejects.toThrow(/both deploy as/);
  });

  test("a bundled object method keeps its `this` and runs on plain Node", async () => {
    const configPath = path.join(dir, "members.prototxt");
    await generate({
      entry: fixture("object-exports.ts"),
      configPath,
      buildDir: path.join(dir, "members-build"),
      project: "members",
    });
    const config = decodeConfig(fs.readFileSync(configPath, "utf8"));
    const getObjects = config.function.find((f) => f.name === "getObjects")!;
    expect(getObjects.source).toMatchObject({ export: "local", member: "getObjects" });
    expect(getObjects.permission).toEqual([{ resource: "objects", path: "img-cache/", action: ["s3:GetObject", "s3:ListBucket"] }]);
    expect(config.function.find((f) => f.name === "put")!.permission).toEqual([
      { resource: "objects", path: "img-cache/", action: ["s3:PutObject"] },
    ]);

    const script = `
      const { handler } = await import(${JSON.stringify(path.join(dir, "members-build/getObjects/index.mjs"))});
      const res = await handler({ rawPath: "/objects/abc", requestContext: { http: { method: "GET" } }, headers: {} });
      console.log(JSON.stringify(res));
    `;
    const proc = Bun.spawnSync(["node", "--input-type=module", "-e", script], {
      env: { ...process.env, CLOUDGEAR_BLOB_DRIVER: "memory" },
      cwd: dir,
    });
    expect(proc.stderr.toString()).toBe("");
    expect(JSON.parse(JSON.parse(proc.stdout.toString()).body)).toEqual({ key: "obj/abc", body: null });
  });

  test("rejects stores that map to the same env var", async () => {
    await expect(
      generate({ entry: fixture("env-collision.ts"), configPath: path.join(dir, "y.prototxt"), buildDir: path.join(dir, "b") }),
    ).rejects.toThrow(/same env var CLOUDGEAR_BLOB_A_B/);
  });

  test("rejects resources whose provider differs from the router's", async () => {
    await expect(
      generate({ entry: fixture("mixed-provider.ts"), configPath: path.join(dir, "x.prototxt"), buildDir: path.join(dir, "b") }),
    ).rejects.toThrow(/uses provider "gcp" but the router uses "aws"/);
  });
});
