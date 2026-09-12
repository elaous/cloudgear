import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateInfraFiles, parseAstForResources } from "../generator";

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", name);

describe("parseAstForResources", () => {
  test("collects every namespaced `new provider.Type(name, ...)` call", async () => {
    const resources = await parseAstForResources(
      path.join(import.meta.dir, "..", "examples", "api-stack.ts"),
    );

    expect(resources).toEqual([
      {
        provider: "aws",
        type: "Lambda",
        name: "handler",
        arguments: ["./src/handler", "index.handler"],
      },
      { provider: "aws", type: "DynamoTable", name: "items", arguments: [] },
      {
        provider: "aws",
        type: "DynamoTable",
        name: "sessions",
        arguments: ["sessionId"],
      },
    ]);
  });

  test("collects resources across multiple providers", async () => {
    const resources = await parseAstForResources(fixture("multi-provider.ts"));

    expect(resources.map((r) => r.provider)).toEqual(["aws", "gcp"]);
    expect(resources.map((r) => r.type)).toEqual(["Lambda", "PubSubTopic"]);
  });

  test("throws when a resource isn't namespaced as provider.Type", async () => {
    await expect(parseAstForResources(fixture("missing-namespace.ts"))).rejects.toThrow(
      /must be namespaced as "<provider>\.<ResourceType>/,
    );
  });

  test("throws when the resource name isn't a plain string literal", async () => {
    await expect(parseAstForResources(fixture("non-string-name.ts"))).rejects.toThrow(
      /first argument \(the resource's name\) must be a plain string literal/,
    );
  });

  test("records null for a non-name argument that isn't a plain string literal", async () => {
    const resources = await parseAstForResources(fixture("null-argument.ts"));

    expect(resources).toEqual([
      { provider: "aws", type: "Lambda", name: "handler", arguments: [null] },
    ]);
  });
});

describe("generateInfraFiles", () => {
  const tmpDirs: string[] = [];

  const makeTmpDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-test-"));
    tmpDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (tmpDirs.length) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  test("writes generated-stack.ts and resources.toml for the given resources", async () => {
    const outDir = makeTmpDir();

    await generateInfraFiles(
      [
        {
          provider: "aws",
          type: "Lambda",
          name: "handler",
          arguments: ["./src/handler", "index.handler"],
        },
        { provider: "aws", type: "DynamoTable", name: "items", arguments: [] },
      ],
      outDir,
    );

    const stack = fs.readFileSync(path.join(outDir, "generated-stack.ts"), "utf8");
    expect(stack).toContain("export class GeneratedStack extends cdk.Stack");
    expect(stack).toContain("new lambda.Function(this, 'handler'");
    expect(stack).toContain("new dynamodb.Table(this, 'items'");

    const toml = fs.readFileSync(path.join(outDir, "resources.toml"), "utf8");
    expect(toml).toContain("[aws.Lambda.handler]");
    expect(toml).toContain("[aws.DynamoTable.items]");
    expect(toml).toContain('url = "PENDING_PROVISION"');
  });

  test("defaults outDir to the current working directory", async () => {
    const outDir = makeTmpDir();
    const originalCwd = process.cwd();
    process.chdir(outDir);

    try {
      await generateInfraFiles([
        { provider: "aws", type: "DynamoTable", name: "items", arguments: [] },
      ]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(fs.existsSync(path.join(outDir, "generated-stack.ts"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "resources.toml"))).toBe(true);
  });

  test("throws when no plugin exists for the resource type", async () => {
    await expect(
      generateInfraFiles(
        [{ provider: "aws", type: "NoSuchResource", name: "x", arguments: [] }],
        makeTmpDir(),
      ),
    ).rejects.toThrow(/No plugin found for resource type "NoSuchResource"/);
  });

  test("throws when a plugin doesn't default-export a generator function", async () => {
    const pluginPath = path.join(import.meta.dir, "..", "plugins", "BrokenPlugin.ts");
    fs.writeFileSync(pluginPath, "export const notDefault = () => '';\n");

    try {
      await expect(
        generateInfraFiles(
          [{ provider: "aws", type: "BrokenPlugin", name: "x", arguments: [] }],
          makeTmpDir(),
        ),
      ).rejects.toThrow(/does not export a default generator function/);
    } finally {
      fs.rmSync(pluginPath, { force: true });
    }
  });
});
