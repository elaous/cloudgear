import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeApp } from "../src/analyze/app";
import { decodeConfig } from "../src/config/schema";
import { generate } from "../src/generate";

// Analyzing an app and bundling functions take seconds when the machine is busy.
setDefaultTimeout(30_000);

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
    expect(Object.keys(byName)).toEqual(["local-getObjects", "local-put"]);
    expect(byName["local-getObjects"]).toMatchObject({ exportName: "local", member: "getObjects" });
    expect(byName["local-getObjects"]!.routes[0]!.name).toBe("getObjects");
    expect(byName["local-put"]).toMatchObject({ exportName: "local", member: "put" });
    expect(accesses(byName["local-getObjects"]!.uses)).toEqual({ "objects:img-cache/": ["read"] });
    expect(accesses(byName["local-put"]!.uses)).toEqual({ "objects:img-cache/": ["write"] });
    expect(byName["local-put"]!.routes).toEqual([{ method: "PUT", path: "/objects/{param}", name: "putObject" }]);
    expect(model.resources.map((r) => r.name)).toEqual(["objects"]);
  });

  test("a store reached through an object property is still traced", () => {
    const model = analyzeApp(fixture("object-property-store.ts"));
    const byName = Object.fromEntries(model.functions.map((f) => [f.name, accesses(f.uses)]));
    expect(byName["svc-viaThis"]).toEqual({ props: ["read"] });
    // svc's initializer hands the store around as a value, so every access is granted
    expect(byName["svc-viaName"]).toEqual({ props: ["delete", "list", "read", "write"] });
    expect(model.warnings).toEqual([expect.stringMatching(/"props" is passed around as a value/)]);
  });

  test("quoted property keys are read like plain ones", () => {
    const model = analyzeApp(fixture("quoted-options.ts"));
    expect(model.authenticated).toBe("none");
    expect(accesses(model.functions[0]!.uses)).toEqual({ "quoted:secret/": ["list"] });
    expect(model.functions[0]!.routes[0]!.name).toBe("listF");
  });

  test("members of different objects may share a method name", () => {
    const model = analyzeApp(fixture("same-method-name.ts"));
    expect(model.functions.map((f) => f.name)).toEqual(["users-get", "orders-get"]);
  });

  test("the default route name is the function's own name, like fn.name at runtime", () => {
    const model = analyzeApp(fixture("export-alias.ts"));
    expect(model.functions[0]).toMatchObject({ name: "handler", declaredName: "impl" });
    expect(model.functions[0]!.routes[0]!.name).toBe("impl");
  });

  describe("DNS, certificate, CDN and API domain", () => {
    test("each Cert carries its own DNS, and the CDN and the router take one each", () => {
      const model = analyzeApp(fixture("edge/app.ts"));
      expect(model.certificates).toEqual([
        { domain: "www.example.com", dns: { provider: "gandi", domain: "www.example.com", zone: "example.com" }, usage: "cdn" },
        { domain: "api.example.com", dns: { provider: "gandi", domain: "api.example.com", zone: "example.com" }, usage: "api" },
      ].map((c) => expect.objectContaining(c)));
      expect(model.cdn).toMatchObject({ provider: "aws", domain: "www.example.com", bucket: "my-site", path: "web/" });
      expect(model.api).toEqual({ provider: "aws", domain: "api.example.com" });
      expect(model.warnings).toEqual([]);
    });

    test("a CDN on its own only serves the bucket, and a Cert needs neither", () => {
      const model = analyzeApp(fixture("edge/bucket-only.ts"));
      expect(model.cdn).toMatchObject({ domain: "www.example.org", bucket: "my-site", path: "" });
      expect(model.api).toBeUndefined();
      expect(model.certificates).toMatchObject([{ domain: "www.example.org", dns: { provider: "aws", zone: "example.org" }, usage: "cdn" }]);
      const certOnly = analyzeApp(fixture("edge/cert-only.ts"));
      expect(certOnly.certificates).toMatchObject([{ domain: "example.com", usage: "" }]);
      expect(certOnly.cdn).toBeUndefined();
    });

    test("a Cert's region and options are read", () => {
      const model = analyzeApp(fixture("edge/api-region.ts"));
      expect(model.certificates[0]).toMatchObject({ domain: "api.example.com", region: "eu-central-1", usage: "api", options: { key_algorithm: "EC_prime256v1" } });
    });

    test("apps without any of them have no edge model", () => {
      const model = analyzeApp(path.join(exampleDir, "main.ts"));
      expect(model.certificates).toEqual([]);
      expect(model.cdn).toBeUndefined();
      expect(model.api).toBeUndefined();
    });

    test("warns about a dry bucket and about a rate limit the API domain bypasses", () => {
      expect(analyzeApp(fixture("edge/dry-bucket.ts")).warnings).toEqual([
        expect.stringMatching(/bucket "existing-site" is dry, but the CDN adds one statement to its bucket policy/),
      ]);
      expect(analyzeApp(fixture("edge/authenticate-all-public.ts")).warnings).toEqual([
        expect.stringMatching(/rateLimit does not apply to routes served on the cert's domain/),
      ]);
    });

    test("a jwtAuth authenticate is read for the functions to verify tokens themselves, even on Authorization", () => {
      const model = analyzeApp(fixture("edge/jwt-ok.ts"));
      expect(model.jwt).toEqual({
        issuer: "https://login.example.com",
        audience: ["app", "web"],
        header: "x-auth-token",
        clockToleranceSeconds: 5,
      });
      expect(Object.fromEntries(model.functions.map((f) => [f.name, f.anonymous]))).toEqual({ health: true, me: false });
      expect(analyzeApp(fixture("edge/authenticate-all-public.ts")).jwt).toBeUndefined();
      expect(analyzeApp(fixture("edge/jwt-authorization.ts")).jwt).toMatchObject({ header: "authorization" });
    });

    test.each([
      ["edge/jwt-mixed.ts", /"both" serves both public and protected routes/],
      ["edge/jwt-variable.ts", /jwtAuth issuer must be a string literal/],
      ["edge/authenticate-bypass.ts", /authenticate hook does not run for "GET \/me"; mark it \{ public: true \}, use jwtAuth, or drop the cert/],
      ["edge/apex-site.ts", /zone apex, which cannot be a CNAME; serve the site from a subdomain/],
      ["edge/apex-api.ts", /zone apex, which cannot be a CNAME; serve the API from a subdomain/],
      ["edge/no-cert-declared.ts", /the router's cert needs a Cert declared with new Cert/],
      ["edge/shared-cert.ts", /the router and the CDN cannot share a Cert/],
      ["edge/same-domain-twice.ts", /a certificate for "api.example.com" is already declared/],
      ["edge/cdn-cert-region.ts", /a CDN needs its certificate in us-east-1, but the Cert says eu-west-1/],
      ["edge/missing-bucket.ts", /the CDN's bucket must be a BlobStore variable/],
      ["edge/spread-cert.ts", /spread in FunctionRouter options cannot be analyzed/],
    ])("rejects %s", (file, error) => {
      expect(() => analyzeApp(fixture(file))).toThrow(error);
    });

    test("warns when the CDN's bucket name contains dots", () => {
      expect(analyzeApp(fixture("edge/dotted-bucket.ts")).warnings).toEqual([
        expect.stringMatching(/bucket "www.example.com" contains dots; CloudFront's HTTPS connection to its S3 endpoint may fail/),
      ]);
      expect(analyzeApp(fixture("edge/bucket-only.ts")).warnings).toEqual([]);
    });

    test("warns when a function uses files the CDN makes public", () => {
      const warnings = analyzeApp(fixture("edge/shared-bucket.ts")).warnings;
      expect(warnings).toEqual([expect.stringMatching(/"readPrivate" also uses the CDN's bucket "my-site" under "private\/"; files there are public through the CDN/)]);
    });

    test("public routes may skip the authenticate hook", () => {
      expect(() => analyzeApp(fixture("edge/authenticate-all-public.ts"))).not.toThrow();
    });
  });

  test("regions come from the router's and each store's options", () => {
    const model = analyzeApp(fixture("regions.ts"));
    expect(model.region).toBe("us-east-2");
    expect(Object.fromEntries(model.resources.map((r) => [r.name, r.region]))).toEqual({ "eu-data": "eu-west-1", "home-data": undefined });
    expect(analyzeApp(path.join(exampleDir, "main.ts")).region).toBeUndefined();
  });

  test("a named function expression's own name is the default route name", () => {
    const model = analyzeApp(fixture("named-function-expression.ts"));
    expect(model.functions[0]!.routes[0]!.name).toBe("inner");
  });

  test("numeric option keys are ignored rather than rejected", () => {
    expect(() => analyzeApp(fixture("numeric-key.ts"))).not.toThrow();
  });

  test("warnings are not repeated for the same line", () => {
    const warnings = analyzeApp(fixture("object-property-store.ts")).warnings;
    expect(new Set(warnings).size).toBe(warnings.length);
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

  test("warns when authenticate cannot reach functions because URLs are public", () => {
    const model = analyzeApp(fixture("none-with-authenticate.ts"));
    expect(model.warnings).toEqual([
      expect.stringMatching(/authenticated is "none"/),
      expect.stringMatching(/authenticate is set but authenticated is "none"; deployed functions will not receive the caller's identity/),
    ]);
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
    ["unexported-object.ts", /must be exported so it can be bundled on its own \(a named function, a method of an exported object/],
    ["grant-unknown-access.ts", /unknown access "execute" in grant\(\)/],
    ["grant-empty.ts", /grant\(store, \.\.\.\) needs at least one access/],
    ["store-path-invalid.ts", /Invalid blob path "a\/\.\.\/b"/],
    ["store-path-variable.ts", /BlobStore path must be a string literal/],
    ["computed-key.ts", /computed property keys cannot be analyzed/],
    ["bad-region.ts", /"Europe" is not an AWS region such as "eu-west-1"/],
    ["region-variable.ts", /region must be a string literal/],
    ["region-conflict.ts", /different provider, region, options or directives/],
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

  test("with a CDN and jwtAuth the bundles verify tokens, except for public functions", async () => {
    const buildDir = path.join(dir, "jwt-build");
    await generate({ entry: fixture("edge/jwt-ok.ts"), configPath: path.join(dir, "jwt.prototxt"), buildDir, project: "jwt" });
    const script = `
      const call = async (name, headers) => {
        const { handler } = await import(${JSON.stringify(buildDir)} + "/" + name + "/index.mjs");
        const res = await handler({ rawPath: name === "me" ? "/me" : "/health", requestContext: { http: { method: "GET" } }, headers });
        return res.statusCode;
      };
      console.log(JSON.stringify([await call("me", {}), await call("me", { "x-auth-token": "garbage" }), await call("health", {})]));
    `;
    const proc = Bun.spawnSync(["node", "--input-type=module", "-e", script], { cwd: dir });
    expect(proc.stderr.toString()).toBe("");
    expect(JSON.parse(proc.stdout.toString())).toEqual([401, 401, 200]);
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
    const getObjects = config.function.find((f) => f.name === "local-getObjects")!;
    expect(getObjects.source).toMatchObject({ export: "local", member: "getObjects" });
    expect(getObjects.permission).toEqual([{ resource: "objects", path: "img-cache/", action: ["s3:GetObject", "s3:ListBucket"] }]);
    expect(config.function.find((f) => f.name === "local-put")!.permission).toEqual([
      { resource: "objects", path: "img-cache/", action: ["s3:PutObject"] },
    ]);

    const script = `
      const { handler } = await import(${JSON.stringify(path.join(dir, "members-build/local-getObjects/index.mjs"))});
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

  test("writes regions into the config and they round-trip", async () => {
    const configPath = path.join(dir, "regions.prototxt");
    const { config } = await generate({ entry: fixture("regions.ts"), configPath, buildDir: path.join(dir, "regions-build"), project: "regions" });
    expect(config.region).toBe("us-east-2");
    expect(config.resource.map((r) => [r.name, r.region])).toEqual([["eu-data", "eu-west-1"], ["home-data", undefined]]);
    const text = fs.readFileSync(configPath, "utf8");
    expect(text).toContain('region: "us-east-2"');
    expect(decodeConfig(text)).toEqual(config);
  });

  test("a bucket named after a domain keeps its name and gets a dotted-safe env var", async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "domain-bucket-"));
    const { config } = await generate({ entry: fixture("domain-bucket.ts"), configPath: path.join(dir2, "c.prototxt"), buildDir: path.join(dir2, "b"), project: "dom" });
    expect(config.resource).toMatchObject([{ name: "assets.example.com", type: "@aws.S3", physical_name: "assets.example.com" }]);
    expect(config.function[0]!.env).toEqual([{ key: "CLOUDGEAR_BLOB_ASSETS_EXAMPLE_COM", value_from: "assets.example.com" }]);
    expect(config.function[0]!.permission).toMatchObject([{ resource: "assets.example.com", path: "img/", action: ["s3:GetObject", "s3:ListBucket"] }]);
  });

  test("rejects stores that map to the same env var", async () => {
    await expect(
      generate({ entry: fixture("env-collision.ts"), configPath: path.join(dir, "y.prototxt"), buildDir: path.join(dir, "b") }),
    ).rejects.toThrow(/same env var CLOUDGEAR_BLOB_A_B/);
  });
});
