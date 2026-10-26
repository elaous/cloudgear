import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeApp } from "../src/analyze/app";
import { generate } from "../src/generate";

setDefaultTimeout(30_000);

const example = path.join(import.meta.dir, "..", "examples", "cdn-app", "main.ts");
const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "policy", name);

describe("@policy on a static method of an exported class", () => {
  test("the CDN example is analyzed: the policy is the function's permissions", () => {
    const model = analyzeApp(example);
    const fn = model.functions.find((f) => f.name === "Local-getObjects")!;
    expect(fn).toMatchObject({ exportName: "Local", member: "getObjects" });
    expect([...fn.uses.values()]).toEqual([{ resource: "mybucket", path: "img-cache/", accesses: new Set(["read", "write", "list"]) }]);
    expect(model.cdn).toMatchObject({ domain: "www.example.com", bucket: "mybucket", path: "img-cache/" });
    expect(model.api).toEqual({ provider: "aws", domain: "api.example.com" });
    expect(model.warnings).toEqual([expect.stringMatching(/also uses the CDN's bucket "mybucket" under "img-cache\/"/)]);
  });

  test("generate scopes the IAM permissions to the policy and the bundle runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-"));
    const { config } = await generate({ entry: example, configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "cdnapp" });
    const fn = config.function[0]!;
    expect(fn.permission).toEqual([{ resource: "mybucket", path: "img-cache/", action: ["s3:GetObject", "s3:ListBucket", "s3:PutObject"] }]);
    expect(fn.source).toMatchObject({ export: "Local", member: "getObjects" });

    const script = `
      const { handler } = await import(${JSON.stringify(path.join(dir, "b/Local-getObjects/index.mjs"))});
      const call = async () => JSON.parse((await handler({ rawPath: "/objects/a.txt", requestContext: { http: { method: "GET" } }, headers: {} })).body);
      console.log(JSON.stringify([await call(), await call()]));
    `;
    const proc = Bun.spawnSync(["node", "--input-type=module", "-e", script], {
      env: { ...process.env, CLOUDGEAR_BLOB_DRIVER: "memory", AWS_LAMBDA_FUNCTION_NAME: "cdnapp-Local-getObjects" },
      cwd: dir,
    });
    expect(proc.stderr.toString()).toBe("");
    expect(JSON.parse(proc.stdout.toString())).toEqual([
      { key: "a.txt", keys: ["a.txt"] },
      { key: "a.txt", body: "generated for a.txt" },
    ]);
  });

  test("@policy works on an instance method reached through an exported instance", async () => {
    const model = analyzeApp(fixture("instance.ts"));
    expect(model.functions.map((f) => [f.name, f.exportName, f.member])).toEqual([["api-read", "api", "read"]]);
    expect([...model.functions[0]!.uses.values()]).toEqual([{ resource: "data", path: "", accesses: new Set(["read"]) }]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-instance-"));
    await generate({ entry: fixture("instance.ts"), configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "app" });
    const script = `
      const { handler } = await import(${JSON.stringify(path.join(dir, "b/api-read/index.mjs"))});
      const res = await handler({ rawPath: "/read", rawQueryString: "key=a", requestContext: { http: { method: "GET" } }, headers: {} });
      console.log(res.body);
    `;
    const proc = Bun.spawnSync(["node", "--input-type=module", "-e", script], {
      env: { ...process.env, CLOUDGEAR_BLOB_DRIVER: "memory", AWS_LAMBDA_FUNCTION_NAME: "x" },
      cwd: dir,
    });
    expect(proc.stderr.toString()).toBe("");
    expect(JSON.parse(proc.stdout.toString())).toEqual({ greeting: "hello", found: false });
  });

  test("the receiver picks the instance when a class has several, and the instance may live in another file", () => {
    const model = analyzeApp(fixture("two-instances-ok.ts"));
    expect(model.functions.map((f) => [f.exportName, f.member])).toEqual([["b", "read"]]);
    const other = analyzeApp(fixture("other-file/main.ts"));
    expect(other.functions.map((f) => [f.file, f.exportName, f.member])).toEqual([["tests/fixtures/router/policy/other-file/main.ts", "api", "read"]]);
  });

  test("a function that does more than its policy allows is refused", () => {
    expect(() => analyzeApp(fixture("exceeds.ts"))).toThrow(/needs permissions\.Put on "data", which its @policy does not allow/);
  });

  test("a policy grants its permissions even when the code does not use them", () => {
    const model = analyzeApp(fixture("unused.ts"));
    expect([...model.functions[0]!.uses.values()][0]!.accesses).toEqual(new Set(["read", "delete"]));
  });

  test("a store passed to a helper cannot be guarded by a policy, unless grant() states what it does", () => {
    expect(() => analyzeApp(fixture("widened.ts"))).toThrow(/passed around as a value, so the @policy of "Api-run" cannot guard it/);
    const model = analyzeApp(fixture("grant-inside.ts"));
    expect([...model.functions[0]!.uses.values()][0]!.accesses).toEqual(new Set(["read", "list"]));
  });

  test("other decorators do not hide a use of a store: it is passed as a value and widened", () => {
    const model = analyzeApp(fixture("other-decorator.ts"));
    expect([...model.functions[0]!.uses.values()][0]!.accesses).toEqual(new Set(["read", "write", "delete", "list"]));
    expect(model.warnings).toEqual([expect.stringMatching(/BlobStore "data" is passed around as a value/)]);
  });

  test("each policy applies to its own store path", () => {
    const uses = [...analyzeApp(fixture("two-paths.ts")).functions[0]!.uses.values()];
    expect(uses.map((u) => [u.path, [...u.accesses]])).toEqual([["images/", ["read"]], ["docs/", ["write"]]]);
  });

  test.each([
    ["bad-permission.ts", /@policy permissions must be permissions\.Get\/Put\/Delete\/List/],
    ["empty.ts", /lists no permissions/],
    ["unknown-store.ts", /@policy needs a BlobStore variable/],
    ["instance-method.ts", /must be exported so it can be bundled on its own/],
    ["instance-unexported.ts", /must be exported so it can be bundled on its own.*no exported instance of Api/],
    ["two-instances.ts", /routed through two different instances \(a, b\)/],
    ["alias.ts", /the receiver must be an exported instance variable itself \(one of api\)/],
  ])("rejects %s", (file, error) => {
    expect(() => analyzeApp(fixture(file))).toThrow(error);
  });
});
