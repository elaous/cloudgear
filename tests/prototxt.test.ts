import { describe, expect, test } from "bun:test";
import { encodePrototxt, parsePrototxt } from "../src/config/prototxt";
import { decodeConfig, encodeConfig, type CloudgearConfig } from "../src/config/schema";

const config: CloudgearConfig = {
  project: "app",
  provider: "aws",
  resource: [{ name: "myblob", type: "@aws.S3", physical_name: "myblob", dry: true, source: "server/api.ts:6" }],
  certificate: [],
  cdn: [],
  function: [
    {
      name: "foo",
      type: "@aws.Lambda",
      physical_name: "app-foo",
      runtime: "nodejs22.x",
      memory_mb: 256,
      timeout_s: 10,
      source: { file: "server/api.ts", export: "foo", input_type: "types.FooInput" },
      route: [{ method: "POST", path: "/foo/{param}", name: "createFoo" }],
      bundle: { path: ".cloudgear/build/foo/index.mjs", sha256: "abc" },
      permission: [{ resource: "myblob", path: "img-cache/", action: ["s3:GetObject", "s3:PutObject"] }],
      env: [{ key: "CLOUDGEAR_BLOB_MYBLOB", value_from: "myblob" }, { key: "LITERAL", value: 'say "hi"' }],
      reserved_concurrency: 5,
    },
  ],
  invoker: ["arn:aws:iam::123456789012:role/vercel", "123456789012"],
  authenticated: "none",
};

describe("prototxt", () => {
  test("config round-trips through encode/decode", () => {
    expect(decodeConfig(encodeConfig(config))).toEqual(config);
  });

  test("encodes repeated fields as repeated keys and messages as blocks", () => {
    const text = encodePrototxt({ name: "x", tag: ["a", "b"], inner: { on: true, n: 3 } });
    expect(text).toBe('name: "x"\ntag: "a"\ntag: "b"\ninner {\n  on: true\n  n: 3\n}\n');
  });

  test("parses comments, list syntax, separators and adjacent strings", () => {
    const parsed = parsePrototxt(
      '# comment\nname: "a" "b"; tag: ["x", "y"], inner < n: -1.5 e: ENUM >\ntag: "z"',
      new Set(["tag"]),
    );
    expect(parsed).toEqual({ name: "ab", tag: ["x", "y", "z"], inner: { n: -1.5, e: "ENUM" } });
  });

  test("rejects a non-repeated field set twice", () => {
    expect(() => parsePrototxt('a: 1\na: 2')).toThrow(/"a" is set more than once/);
  });

  test("reports the line of a syntax error", () => {
    expect(() => parsePrototxt('a: 1\n}')).toThrow(/prototxt:2: expected a field name/);
    expect(() => parsePrototxt("a {\n b: 1\n")).toThrow(/expected "}"/);
  });

  test("decodeConfig requires mandatory fields", () => {
    expect(() => decodeConfig('provider: "aws"')).toThrow(/missing string field "project"/);
  });
});
