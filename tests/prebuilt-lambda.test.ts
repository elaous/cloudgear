import { describe, expect, test } from "bun:test";
import type { CloudgearConfig, FunctionSpec } from "../src/config/schema";
import { hashContents } from "../src/build/bundle";
import { decodeConfig, encodeConfig } from "../src/config/schema";
import { apply } from "../src/deploy/apply";
import { awsDrivers } from "../src/deploy/aws";
import { plan } from "../src/deploy/plan";
import { baseConfig, emptyState, fakeAws, fn } from "./helpers";

const ZIP = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5]);

const archiveFn = (overrides: Partial<FunctionSpec> = {}): FunctionSpec =>
  fn({
    runtime: "provided.al2023",
    handler: "bootstrap",
    architecture: "arm64",
    bundle: { path: "bin/report.zip", sha256: "z1", archive: true },
    ...overrides,
  });

const config = (f: FunctionSpec): CloudgearConfig => baseConfig({ function: [f] });

function drivers() {
  const aws = fakeAws();
  const real = awsDrivers({
    region: "eu-west-1",
    readBundle: () => ZIP,
    readIncluded: () => [],
    clients: { s3: aws.client, lambda: aws.client, iam: aws.client, acm: aws.client, cloudfront: aws.client, events: aws.client, apigateway: aws.client, ec2: aws.client, elasticache: aws.client },
    sleep: async () => {},
    log: () => {},
  });
  return { aws, real };
}

const run = (cfg: CloudgearConfig, state: ReturnType<typeof emptyState>, real: ReturnType<typeof drivers>["real"]) => apply(plan(cfg, state), state, real, { save: () => {}, log: () => {} });

describe("the config", () => {
  test("a finished zip with its handler and architecture survives encoding", () => {
    const decoded = decodeConfig(encodeConfig(config(archiveFn())));
    const f = decoded.function[0]!;
    expect(f).toMatchObject({ handler: "bootstrap", architecture: "arm64", runtime: "provided.al2023" });
    expect(f.bundle).toEqual({ path: "bin/report.zip", sha256: "z1", archive: true });
  });

  test("a script bundle has none of the new fields", () => {
    const f = decodeConfig(encodeConfig(config(fn()))).function[0]!;
    expect(f.handler).toBeUndefined();
    expect(f.architecture).toBeUndefined();
    expect(f.bundle.archive).toBeUndefined();
  });

  test("the combinations that cannot work are refused", () => {
    const decode = (f: FunctionSpec) => decodeConfig(encodeConfig(config(f)));
    expect(() => decode(archiveFn({ architecture: "mips" as never }))).toThrow(/architecture must be x86_64 or arm64, got "mips"/);
    expect(() => decode(fn({ handler: "bootstrap" }))).toThrow(/handler only applies to an archive bundle/);
    expect(() => decode(archiveFn({ include: ["dist/index.html"] }))).toThrow(/an archive bundle is uploaded as it is, so it cannot have include/);
    expect(() => decode(archiveFn({ handler: undefined }))).toThrow(/an archive bundle needs a handler/);
    expect(() => decode(fn({ architecture: "arm64" }))).not.toThrow();
  });
});

describe("the hash", () => {
  test("of a zip with no included files is the SHA-256 of the file", () => {
    expect(hashContents(ZIP, [])).toBe(new Bun.CryptoHasher("sha256").update(ZIP).digest("hex"));
  });
});

describe("planning", () => {
  test("only a finished zip adds fields to the comparable spec", () => {
    const plain = plan(config(fn()), emptyState()).find((a) => a.kind === "function")!.desired!.spec as Record<string, unknown>;
    expect("archive" in plain || "handler" in plain || "architecture" in plain).toBe(false);
    const built = plan(config(archiveFn()), emptyState()).find((a) => a.kind === "function")!.desired!.spec as Record<string, unknown>;
    expect(built).toMatchObject({ archive: true, handler: "bootstrap", architecture: "arm64" });
  });

  test("a new handler is a config change and a new architecture a code change", async () => {
    const { real } = drivers();
    const state = emptyState();
    await run(config(archiveFn()), state, real);
    const changes = (f: FunctionSpec) => plan(config(f), state).find((a) => a.kind === "function")!.changes;
    expect(changes(archiveFn())).toEqual([]);
    expect(changes(archiveFn({ handler: "main" }))).toEqual(["config"]);
    expect(changes(archiveFn({ architecture: "x86_64" }))).toEqual(["code"]);
  });

  test("only a Lambda can take a finished zip", () => {
    const gcp = baseConfig({ provider: "gcp", function: [archiveFn({ type: "@gcp.CloudFunction" })], resource: [] });
    expect(() => plan(gcp, emptyState())).toThrow(/cannot take a finished zip, a handler or an architecture; only @aws.Lambda can/);
  });
});

describe("applying to Lambda", () => {
  test("the zip goes up unmodified with its handler, runtime and architecture", async () => {
    const { aws, real } = drivers();
    await run(config(archiveFn()), emptyState(), real);
    const [create] = aws.of("CreateFunctionCommand");
    expect(create.Handler).toBe("bootstrap");
    expect(create.Runtime).toBe("provided.al2023");
    expect(create.Architectures).toEqual(["arm64"]);
    expect([...create.Code.ZipFile]).toEqual([...ZIP]);
  });

  test("a script bundle is still wrapped as index.mjs with index.handler and no architecture", async () => {
    const aws = fakeAws();
    await run(config(fn()), emptyState(), aws.drivers);
    const [create] = aws.of("CreateFunctionCommand");
    expect(create.Handler).toBe("index.handler");
    expect("Architectures" in create).toBe(false);
    expect(create.Code.ZipFile.length).toBeGreaterThan(0);
    expect([...create.Code.ZipFile.slice(0, 2)]).toEqual([0x50, 0x4b]);
  });

  test("a new handler updates the configuration and a new architecture the code", async () => {
    const { aws, real } = drivers();
    const state = emptyState();
    await run(config(archiveFn()), state, real);
    await run(config(archiveFn({ handler: "main" })), state, real);
    expect(aws.of("UpdateFunctionConfigurationCommand").at(-1)).toMatchObject({ Handler: "main" });
    await run(config(archiveFn({ handler: "main", architecture: "x86_64" })), state, real);
    const [update] = aws.of("UpdateFunctionCodeCommand");
    expect(update.Architectures).toEqual(["x86_64"]);
    expect([...update.ZipFile]).toEqual([...ZIP]);
  });
});
