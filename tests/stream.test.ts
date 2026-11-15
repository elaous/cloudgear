import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Stream } from "@cloudgear/stream";
import { analyzeApp } from "../src/analyze/app";
import { adoptEntries } from "../src/deploy/adopt";
import { apply, type Drivers } from "../src/deploy/apply";
import { awsDrivers, type SendClient } from "../src/deploy/aws";
import { plan } from "../src/deploy/plan";
import { stateKey } from "../src/deploy/state";
import { validateOptions } from "../src/providers";
import type { CloudgearConfig } from "../src/config/schema";
import { generate } from "../src/generate";
import { baseConfig, emptyState } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "stream", `${name}.ts`);
const KEY = stateKey({ type: "@aws.Kinesis", name: "stream.app" });

interface Fake {
  arn: string;
  status: string;
  busy: number;
  mode: string;
  shards: number;
  retention: number;
  tags?: unknown;
}

function fakeKinesis(initial: Record<string, Partial<Fake>> = {}, opts: { stuck?: boolean; raceOnCreate?: boolean } = {}) {
  const streams = new Map<string, Fake>(
    Object.entries(initial).map(([name, s]) => [name, { arn: `arn:aws:kinesis:eu-west-1:1:stream/${name}`, status: "ACTIVE", busy: 0, mode: "PROVISIONED", shards: 1, retention: 24, ...s }]),
  );
  const calls: { name: string; input: any }[] = [];
  const sleeps: number[] = [];
  const err = (name: string) => Object.assign(new Error(name), { name });
  let raced = false;
  const byArn = (arn: string) => [...streams.values()].find((s) => s.arn === arn);
  const mutate = (stream: Fake | undefined, change: (s: Fake) => void) => {
    if (!stream) throw err("ResourceNotFoundException");
    if (stream.busy > 0 || stream.status !== "ACTIVE") throw err("ResourceInUseException");
    change(stream);
    stream.busy = 2;
  };
  const client: SendClient = {
    async send(command) {
      const name = command.constructor.name as string;
      const input = command.input;
      calls.push({ name, input });
      switch (name) {
        case "DescribeStreamSummaryCommand": {
          const stream = streams.get(input.StreamName);
          if (!stream) throw err("ResourceNotFoundException");
          const status = opts.stuck ? "CREATING" : stream.busy > 0 ? "UPDATING" : stream.status;
          if (stream.busy > 0) stream.busy--;
          return { StreamDescriptionSummary: { StreamARN: stream.arn, StreamStatus: status, StreamModeDetails: { StreamMode: stream.mode }, OpenShardCount: stream.shards, RetentionPeriodHours: stream.retention } };
        }
        case "CreateStreamCommand": {
          if (opts.raceOnCreate && !raced) {
            raced = true;
            streams.set(input.StreamName, { arn: `arn:aws:kinesis:eu-west-1:1:stream/${input.StreamName}`, status: "ACTIVE", busy: 0, mode: "PROVISIONED", shards: 1, retention: 24 });
            throw err("ResourceInUseException");
          }
          if (streams.has(input.StreamName)) throw err("ResourceInUseException");
          streams.set(input.StreamName, { arn: `arn:aws:kinesis:eu-west-1:1:stream/${input.StreamName}`, status: "ACTIVE", busy: 2, mode: input.StreamModeDetails.StreamMode, shards: input.ShardCount ?? 0, retention: 24, tags: input.Tags });
          return {};
        }
        case "UpdateStreamModeCommand":
          mutate(byArn(input.StreamARN), (s) => (s.mode = input.StreamModeDetails.StreamMode));
          return {};
        case "UpdateShardCountCommand":
          mutate(streams.get(input.StreamName), (s) => (s.shards = input.TargetShardCount));
          return {};
        case "IncreaseStreamRetentionPeriodCommand":
        case "DecreaseStreamRetentionPeriodCommand":
          mutate(streams.get(input.StreamName), (s) => (s.retention = input.RetentionPeriodHours));
          return {};
        case "DeleteStreamCommand":
          if (!streams.delete(input.StreamName)) throw err("ResourceNotFoundException");
          return {};
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const logs: string[] = [];
  const drivers = awsDrivers({
    region: "eu-west-1",
    tags: { "cloudgear:project": "app" },
    readBundle: () => new Uint8Array(),
    clients: { kinesis: client },
    sleep: async (ms) => void sleeps.push(ms),
    log: (m) => void logs.push(m),
  });
  return { streams, calls, sleeps, logs, drivers, names: () => calls.map((c) => c.name) };
}

const configWith = (options?: Record<string, string>): CloudgearConfig =>
  baseConfig({ resource: [{ name: "stream.app", type: "@aws.Kinesis", physical_name: "app", dry: false, source: "setup.ts:1", ...(options ? { options } : {}) }], function: [] });
const empty = () => baseConfig({ resource: [], function: [] });

async function applyConfig(config: CloudgearConfig, state: ReturnType<typeof emptyState>, drivers: Drivers) {
  await apply(plan(config, state), state, drivers, { save: () => {}, log: () => {} });
}

describe("Stream", () => {
  test("validates the provider, name, mode, shards and retention without side effects", () => {
    expect(new Stream("aws", "events", { shards: 2, retentionHours: 48 }).name).toBe("events");
    expect(() => new Stream("gcp" as "aws", "s")).toThrow(/not supported yet/);
    expect(() => new Stream("aws", "bad name")).toThrow(/Invalid stream name/);
    expect(() => new Stream("aws", "s", { mode: "fast" as "on-demand" })).toThrow(/Unsupported stream mode/);
    expect(() => new Stream("aws", "s", { shards: 0 })).toThrow(/shards must be/);
    expect(() => new Stream("aws", "s", { mode: "on-demand", shards: 2 })).toThrow(/shards only applies to provisioned/);
    expect(() => new Stream("aws", "s", { retentionHours: 12 })).toThrow(/retentionHours must be/);
    expect(() => new Stream("aws", "s", { retentionHours: 9000 })).toThrow(/retentionHours must be/);
  });
});

describe("analysis", () => {
  test("streams become @aws.Kinesis resources carrying only what was set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-"));
    const { config } = await generate({ entry: fixture("basic"), configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "app" });
    expect(config.resource.map((r) => [r.name, r.type, r.physical_name, r.options])).toEqual([
      ["stream.tranquilo-events", "@aws.Kinesis", "tranquilo-events", { mode: "provisioned", shards: "2", retention_hours: "48", allow_destroy: "true" }],
      ["stream.bursty", "@aws.Kinesis", "bursty", { mode: "on-demand" }],
      ["stream.plain", "@aws.Kinesis", "plain", {}],
    ]);
  });

  test("duplicates, unknown options, on-demand shards, a bad name and a short retention are errors", () => {
    expect(() => analyzeApp(fixture("duplicate"))).toThrow(/Stream "same" is also declared at/);
    expect(() => analyzeApp(fixture("typo"))).toThrow(/unknown Stream option "shard" \(supported: mode, shards, retentionHours, allowDestroy\)/);
    expect(() => analyzeApp(fixture("on-demand-shards"))).toThrow(/shards only applies to provisioned mode/);
    expect(() => analyzeApp(fixture("bad-name"))).toThrow(/Invalid stream name "bad name"/);
    expect(() => analyzeApp(fixture("retention-low"))).toThrow(/retentionHours must be a whole number from 24 to 8760/);
  });
});

describe("kinesis driver", () => {
  test("creates a provisioned one-shard stream with tags and waits until it is ACTIVE", async () => {
    const k = fakeKinesis();
    const state = emptyState();
    await applyConfig(configWith(), state, k.drivers);
    const create = k.calls.find((c) => c.name === "CreateStreamCommand")!.input;
    expect(create).toMatchObject({ StreamName: "app", StreamModeDetails: { StreamMode: "PROVISIONED" }, ShardCount: 1 });
    expect(create.Tags).toMatchObject({ "cloudgear:project": "app" });
    expect(k.sleeps.length).toBeGreaterThan(0);
    expect(state.entries[KEY]!.outputs).toEqual({ arn: "arn:aws:kinesis:eu-west-1:1:stream/app", mode: "provisioned", shards: "1", retention_hours: "24" });
    expect(plan(configWith(), state).every((a) => a.op === "noop")).toBe(true);
  });

  test("an on-demand stream is created without a shard count", async () => {
    const k = fakeKinesis();
    await applyConfig(configWith({ mode: "on-demand" }), emptyState(), k.drivers);
    const create = k.calls.find((c) => c.name === "CreateStreamCommand")!.input;
    expect(create.StreamModeDetails).toEqual({ StreamMode: "ON_DEMAND" });
    expect("ShardCount" in create).toBe(false);
  });

  test("an existing stream keeps every setting the config does not name", async () => {
    const k = fakeKinesis({ app: { shards: 4, retention: 168, mode: "PROVISIONED" } });
    await applyConfig(configWith(), emptyState(), k.drivers);
    expect(k.names().filter((n) => n !== "DescribeStreamSummaryCommand")).toEqual([]);
    expect(k.streams.get("app")).toMatchObject({ shards: 4, retention: 168 });
    expect(k.logs).toContain("adopted existing Kinesis stream app");
  });

  test("named settings are changed one at a time, waiting between changes", async () => {
    const k = fakeKinesis({ app: { shards: 1, retention: 24, mode: "ON_DEMAND" } });
    await applyConfig(configWith({ mode: "provisioned", shards: "3", retention_hours: "48" }), emptyState(), k.drivers);
    expect(k.names().filter((n) => n !== "DescribeStreamSummaryCommand")).toEqual(["UpdateStreamModeCommand", "UpdateShardCountCommand", "IncreaseStreamRetentionPeriodCommand"]);
    expect(k.calls.find((c) => c.name === "UpdateShardCountCommand")!.input).toMatchObject({ TargetShardCount: 3, ScalingType: "UNIFORM_SCALING" });
    expect(k.streams.get("app")).toMatchObject({ mode: "PROVISIONED", shards: 3, retention: 48 });

    const lower = fakeKinesis({ app: { retention: 168 } });
    await applyConfig(configWith({ retention_hours: "24" }), emptyState(), lower.drivers);
    expect(lower.names()).toContain("DecreaseStreamRetentionPeriodCommand");
  });

  test("a stream that appears between the check and the create is adopted", async () => {
    const k = fakeKinesis({}, { raceOnCreate: true });
    await applyConfig(configWith(), emptyState(), k.drivers);
    expect(k.streams.size).toBe(1);
  });

  test("a stream that never becomes ACTIVE fails clearly and the next apply adopts it", async () => {
    const k = fakeKinesis({}, { stuck: true });
    await expect(applyConfig(configWith(), emptyState(), k.drivers)).rejects.toThrow(/still not ACTIVE after 300 seconds; run apply again/);
    expect(k.sleeps).toHaveLength(60);
    const retry = fakeKinesis({ app: {} });
    await applyConfig(configWith(), emptyState(), retry.drivers);
    expect(retry.names()).not.toContain("CreateStreamCommand");
  });

  test("destroy refuses an unprotected stream before changing anything, and deletes a protected one", async () => {
    const guarded = fakeKinesis();
    const savedGuarded = emptyState();
    await applyConfig(configWith(), savedGuarded, guarded.drivers);
    await expect(applyConfig(empty(), savedGuarded, guarded.drivers)).rejects.toThrow(/^Nothing was changed\. Refusing to delete Kinesis stream "app"/);
    expect(guarded.streams.size).toBe(1);

    const open = fakeKinesis();
    const savedOpen = emptyState();
    await applyConfig(configWith({ allow_destroy: "true" }), savedOpen, open.drivers);
    await applyConfig(empty(), savedOpen, open.drivers);
    expect(open.streams.size).toBe(0);
    expect(open.calls.find((c) => c.name === "DeleteStreamCommand")!.input).toEqual({ StreamName: "app", EnforceConsumerDeletion: false });
    expect(savedOpen.entries).toEqual({});
  });

  test("a stream that is already gone does not fail the delete", async () => {
    const k = fakeKinesis();
    const state = emptyState();
    await applyConfig(configWith({ allow_destroy: "true" }), state, k.drivers);
    k.streams.clear();
    await applyConfig(empty(), state, k.drivers);
    expect(state.entries).toEqual({});
  });

  test("adopt reads only, records the spec when the stream matches, and explains when not", async () => {
    const k = fakeKinesis({ app: { shards: 2, retention: 24 } });
    const [matching] = plan(configWith({ shards: "2", allow_destroy: "true" }), emptyState()).map((a) => a.desired!);
    const ok = await k.drivers["@aws.Kinesis"]!.adopt!(matching!, { entry: () => undefined });
    expect(ok!.spec).toEqual({ physical_name: "app", region: "", options: { shards: "2" } });
    expect(k.names().every((n) => n === "DescribeStreamSummaryCommand")).toBe(true);

    const [differing] = plan(configWith({ shards: "5", retention_hours: "72" }), emptyState()).map((a) => a.desired!);
    const mismatch = await k.drivers["@aws.Kinesis"]!.adopt!(differing!, { entry: () => undefined });
    expect(mismatch!.spec).toEqual({ physical_name: "app" });
    expect(mismatch!.notes![0]).toMatch(/2 shards \(config: 5\); retention is 24 hours \(config: 72\)/);
    expect(await fakeKinesis().drivers["@aws.Kinesis"]!.adopt!(matching!, { entry: () => undefined })).toBeUndefined();
  });

  test("import grants no deletion; the next apply does", async () => {
    const k = fakeKinesis({ app: {} });
    const state = emptyState();
    const config = configWith({ allow_destroy: "true" });
    expect((await adoptEntries(plan(config, state), state, k.drivers, () => true)).adopted).toHaveLength(1);
    await expect(applyConfig(empty(), state, k.drivers)).rejects.toThrow(/Nothing was changed/);
    expect(plan(config, state).map((a) => a.op)).toEqual(["update"]);
    await applyConfig(config, state, k.drivers);
    await applyConfig(empty(), state, k.drivers);
    expect(k.streams.size).toBe(0);
  });
});

describe("option validation", () => {
  test("Kinesis options are checked", () => {
    validateOptions("aws", "@aws.Kinesis", { mode: "on-demand", shards: "10000", retention_hours: "8760", allow_destroy: "true" }, "s");
    expect(() => validateOptions("aws", "@aws.Kinesis", { mode: "fast" }, "s")).toThrow(/must be one of provisioned, on-demand/);
    expect(() => validateOptions("aws", "@aws.Kinesis", { shards: "0" }, "s")).toThrow(/must be an integer from 1 to 10000/);
    expect(() => validateOptions("aws", "@aws.Kinesis", { retention_hours: "23" }, "s")).toThrow(/must be an integer from 24 to 8760/);
    expect(() => validateOptions("aws", "@aws.Kinesis", { allow_destroy: "false" }, "s")).toThrow(/must be one of true/);
    expect(() => validateOptions("aws", "@aws.Kinesis", { tier: "x" }, "s")).toThrow(/unknown option "tier"/);
  });
});
