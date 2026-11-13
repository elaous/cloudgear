import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../src/deploy/apply";
import { plan } from "../src/deploy/plan";
import { serializeState, type State } from "../src/deploy/state";
import { parseS3Location, S3StateStore, STATE_CHANGED, type LockInfo } from "../src/deploy/state-s3";
import { createStateStore, holdLock, LocalStateStore, stateLocation } from "../src/deploy/state-store";
import { stateCommand } from "../src/statecmd";
import { FakeS3, s3Error } from "./fake-s3";
import { baseConfig, emptyState, fakeAws } from "./helpers";

const BUCKET = "state.tranquilo.art";
const location = parseS3Location(`s3://${BUCKET}/tranquilo-app/`);

function stateWith(name: string): State {
  const state = emptyState();
  state.entries[`@aws.S3.${name}`] = { kind: "resource", type: "@aws.S3", name, physical_name: name, spec: {}, outputs: {} };
  return state;
}

describe("parseS3Location", () => {
  test("splits bucket and prefix, with or without trailing slash", () => {
    expect(parseS3Location("s3://state.tranquilo.art/tranquilo-app/")).toEqual({ bucket: "state.tranquilo.art", prefix: "tranquilo-app/" });
    expect(parseS3Location("s3://state.tranquilo.art/tranquilo-app")).toEqual({ bucket: "state.tranquilo.art", prefix: "tranquilo-app/" });
    expect(parseS3Location("s3://state.tranquilo.art/a/b/")).toEqual({ bucket: "state.tranquilo.art", prefix: "a/b/" });
  });

  test("allows an empty prefix", () => {
    expect(parseS3Location("s3://my-bucket")).toEqual({ bucket: "my-bucket", prefix: "" });
    expect(parseS3Location("s3://my-bucket/")).toEqual({ bucket: "my-bucket", prefix: "" });
  });

  test("reads the region query parameter", () => {
    expect(parseS3Location("s3://my-bucket/p?region=us-east-1")).toEqual({ bucket: "my-bucket", prefix: "p/", region: "us-east-1" });
  });

  test("rejects bad locations with a clear error", () => {
    expect(() => parseS3Location("s3:///prefix")).toThrow(/no bucket/);
    expect(() => parseS3Location("s3://")).toThrow(/no bucket/);
    expect(() => parseS3Location("s3://my-bucket/a/../b")).toThrow(/"\.\."/);
    expect(() => parseS3Location("s3://my-bucket/..")).toThrow(/"\.\."/);
    expect(() => parseS3Location("s3://my-bucket/a//b")).toThrow(/empty/);
    expect(() => parseS3Location("https://my-bucket/p")).toThrow(/s3:\/\/ scheme/);
    expect(() => parseS3Location("gs://my-bucket/p")).toThrow(/s3:\/\/ scheme/);
    expect(() => parseS3Location("my-bucket/p")).toThrow(/s3:\/\/<bucket>/);
    expect(() => parseS3Location("s3://My_Bucket/p")).toThrow(/invalid bucket/);
    expect(() => parseS3Location("s3://my-bucket/p?colour=red")).toThrow(/unknown option/);
    expect(() => parseS3Location("s3://my-bucket/p?region=")).toThrow(/empty region/);
  });

  test("the SDK addresses a dotted bucket in path style", async () => {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    let url = "";
    const client = new S3Client({
      region: "us-east-1",
      credentials: { accessKeyId: "x", secretAccessKey: "y" },
      requestHandler: {
        metadata: { handlerProtocol: "http/1.1" },
        handle: async (request: { hostname: string; path: string }) => {
          url = `${request.hostname}${request.path}`;
          throw new Error("stop");
        },
        destroy() {},
      },
    });
    await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: "tranquilo-app/state.json" })).catch(() => {});
    expect(url).toBe("s3.us-east-1.amazonaws.com/state.tranquilo.art/tranquilo-app/state.json");
  });
});

describe("stateLocation", () => {
  test("the flag wins over the environment, and empty means local", () => {
    expect(stateLocation("s3://a/b", "s3://c/d")).toBe("s3://a/b");
    expect(stateLocation(undefined, "s3://c/d")).toBe("s3://c/d");
    expect(stateLocation(undefined, "")).toBeUndefined();
    expect(stateLocation(undefined, undefined)).toBeUndefined();
  });
});

describe("S3StateStore", () => {
  let dir: string;
  let s3: FakeS3;
  let warnings: string[];
  const open = (client = s3, cachePath: string | undefined = path.join(dir, ".cloudgear", "state.json"), holder?: string) =>
    new S3StateStore(location, { client, cachePath, warn: (m) => warnings.push(m), holder });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-state-"));
    s3 = new FakeS3();
    warnings = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("loads an empty state when nothing exists, without creating a local file", async () => {
    const store = open();
    const { state, version } = await store.load("app", "aws");
    expect(state).toEqual(emptyState());
    expect(version).toBeUndefined();
    expect(fs.existsSync(path.join(dir, ".cloudgear", "state.json"))).toBe(false);
  });

  test("save then load round trips through the right keys and settings", async () => {
    const writer = open();
    await writer.load("app", "aws");
    await writer.save(stateWith("one"));
    expect(Object.keys(Object.fromEntries(s3.objects))).toEqual([`${BUCKET}/tranquilo-app/state.json`]);
    const put = s3.callsOf("PutObjectCommand")[0]!.input;
    expect(put).toMatchObject({ Bucket: BUCKET, Key: "tranquilo-app/state.json", ContentType: "application/json", ServerSideEncryption: "AES256", IfNoneMatch: "*" });
    expect(put.IfMatch).toBeUndefined();

    const reader = open(s3, path.join(dir, "other", "state.json"));
    const loaded = await reader.load("app", "aws");
    expect(loaded.state).toEqual(stateWith("one"));
    expect(loaded.version).toBe(s3.objects.get(`${BUCKET}/tranquilo-app/state.json`)!.etag);

    await reader.save(stateWith("two"));
    expect(s3.callsOf("PutObjectCommand").at(-1)!.input.IfMatch).toBe(loaded.version);
  });

  test("keeps the same validation errors as the local file", async () => {
    s3.put(BUCKET, "tranquilo-app/state.json", JSON.stringify({ ...emptyState(), version: 2 }));
    await expect(open().load("app", "aws")).rejects.toThrow(/unsupported state version 2/);
    s3.put(BUCKET, "tranquilo-app/state.json", serializeState(emptyState()));
    await expect(open().load("other", "aws")).rejects.toThrow(/belongs to project "app" \(aws\), config is "other" \(aws\)/);
    await expect(open().load("app", "gcp")).rejects.toThrow(/belongs to project "app" \(aws\), config is "app" \(gcp\)/);
  });

  test("refuses to save before reading", async () => {
    await expect(open().save(emptyState())).rejects.toThrow(/not read/);
  });

  test("a second writer is refused with a clear error", async () => {
    const a = open(s3, path.join(dir, "a", "state.json"));
    const b = open(s3, path.join(dir, "b", "state.json"));
    await a.load("app", "aws");
    await b.load("app", "aws");
    await a.save(stateWith("a"));
    await expect(b.save(stateWith("b"))).rejects.toThrow(STATE_CHANGED);
    const c = open(s3, path.join(dir, "c", "state.json"));
    expect((await c.load("app", "aws")).state).toEqual(stateWith("a"));
    await c.save(stateWith("c"));
    await expect(a.save(stateWith("a2"))).rejects.toThrow(STATE_CHANGED);
    expect(JSON.parse(s3.body(BUCKET, "tranquilo-app/state.json")!)).toEqual(stateWith("c"));
  });

  test("two first writers on an empty bucket cannot both win", async () => {
    const a = open(s3, path.join(dir, "a", "state.json"));
    const b = open(s3, path.join(dir, "b", "state.json"));
    await a.load("app", "aws");
    await b.load("app", "aws");
    await a.save(stateWith("a"));
    await expect(b.save(stateWith("b"))).rejects.toThrow(STATE_CHANGED);
  });

  test("a ConditionalRequestConflict is retried once", async () => {
    const store = open();
    await store.load("app", "aws");
    let failures = 1;
    s3.failWhen = (call) => (call.command === "PutObjectCommand" && failures-- > 0 ? s3Error("ConditionalRequestConflict", 409) : undefined);
    await store.save(stateWith("one"));
    expect(s3.callsOf("PutObjectCommand")).toHaveLength(2);

    failures = 2;
    await expect(store.save(stateWith("two"))).rejects.toThrow(STATE_CHANGED);
  });

  test("a failed PutObject leaves the previous state and the next save still works", async () => {
    const store = open();
    await store.load("app", "aws");
    await store.save(stateWith("one"));
    s3.failWhen = (call) => (call.command === "PutObjectCommand" ? s3Error("InternalError", 500) : undefined);
    await expect(store.save(stateWith("two"))).rejects.toThrow("InternalError");
    expect(JSON.parse(s3.body(BUCKET, "tranquilo-app/state.json")!)).toEqual(stateWith("one"));
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".cloudgear", "state.json"), "utf8"))).toEqual(stateWith("one"));
    s3.failWhen = undefined;
    await store.save(stateWith("two"));
    expect(JSON.parse(s3.body(BUCKET, "tranquilo-app/state.json")!)).toEqual(stateWith("two"));
  });

  test("access denied explains the permissions needed", async () => {
    s3.failWhen = () => s3Error("AccessDenied", 403);
    await expect(open().load("app", "aws")).rejects.toThrow(/s3:ListBucket/);
  });

  test("mirrors to the local cache and never reads from it", async () => {
    const cache = path.join(dir, ".cloudgear", "state.json");
    const store = open();
    await store.load("app", "aws");
    await store.save(stateWith("one"));
    expect(JSON.parse(fs.readFileSync(cache, "utf8"))).toEqual(stateWith("one"));
    expect(warnings).toEqual([]);

    s3.put(BUCKET, "tranquilo-app/state.json", serializeState(stateWith("remote")));
    fs.writeFileSync(cache, serializeState(stateWith("stale")));
    const fresh = open();
    expect((await fresh.load("app", "aws")).state).toEqual(stateWith("remote"));
    expect(warnings).toEqual([]);
    expect(JSON.parse(fs.readFileSync(cache, "utf8"))).toEqual(stateWith("remote"));
  });

  test("warns once about a differing local state, keeps a copy and never touches the remote", async () => {
    const cache = path.join(dir, ".cloudgear", "state.json");
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, serializeState(stateWith("local")));
    s3.put(BUCKET, "tranquilo-app/state.json", serializeState(stateWith("remote")));
    const before = s3.body(BUCKET, "tranquilo-app/state.json");

    const store = open();
    await store.load("app", "aws");
    await store.load("app", "aws");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/differs from the remote state/);
    expect(warnings[0]).toMatch(/state push --force/);
    expect(JSON.parse(fs.readFileSync(`${cache}.pre-remote`, "utf8"))).toEqual(stateWith("local"));
    expect(s3.body(BUCKET, "tranquilo-app/state.json")).toBe(before);
    expect(s3.callsOf("PutObjectCommand")).toHaveLength(0);
  });

  test("warns and leaves the local file alone when the remote has no state yet", async () => {
    const cache = path.join(dir, ".cloudgear", "state.json");
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, serializeState(stateWith("local")));
    await open().load("app", "aws");
    expect(warnings[0]).toMatch(/holds no state.*state push/);
    expect(JSON.parse(fs.readFileSync(cache, "utf8"))).toEqual(stateWith("local"));
  });

  test("does not warn when the local state equals the remote", async () => {
    const cache = path.join(dir, ".cloudgear", "state.json");
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, serializeState(stateWith("same")));
    s3.put(BUCKET, "tranquilo-app/state.json", serializeState(stateWith("same")));
    await open().load("app", "aws");
    expect(warnings).toEqual([]);
    expect(fs.existsSync(`${cache}.pre-remote`)).toBe(false);
  });

  describe("lock", () => {
    const lockKey = "tranquilo-app/state.lock";

    test("is taken with IfNoneMatch and describes the holder", async () => {
      const release = await open(s3, undefined, "ana@laptop").lock({ command: "apply --auto-approve" });
      const put = s3.callsOf("PutObjectCommand")[0]!.input;
      expect(put).toMatchObject({ Key: lockKey, IfNoneMatch: "*", ServerSideEncryption: "AES256", ContentType: "application/json" });
      const info = JSON.parse(s3.body(BUCKET, lockKey)!) as LockInfo;
      expect(info).toMatchObject({ holder: "ana@laptop", command: "apply --auto-approve", pid: process.pid });
      expect(info.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Date(info.since).toISOString()).toBe(info.since);
      await release();
      expect(s3.body(BUCKET, lockKey)).toBeUndefined();
      await release();
    });

    test("a held lock names its holder and the way out", async () => {
      await open(s3, undefined, "ana@laptop").lock({ command: "apply" });
      await expect(open(s3, undefined, "bob@ci").lock({ command: "destroy" })).rejects.toThrow(
        /state is locked by ana@laptop since \S+ \(command apply\); if that run is dead, run cloudgear state unlock --force/,
      );
    });

    test("can be taken again after release", async () => {
      const first = await open().lock({ command: "apply" });
      await first();
      const second = await open().lock({ command: "apply" });
      await second();
    });

    test("releasing never deletes someone else's lock", async () => {
      const mine = await open().lock({ command: "apply" });
      s3.objects.delete(`${BUCKET}/${lockKey}`);
      const theirs = await open(s3, undefined, "bob@ci").lock({ command: "destroy" });
      await mine();
      expect((JSON.parse(s3.body(BUCKET, lockKey)!) as LockInfo).holder).toBe("bob@ci");
      await theirs();
      expect(s3.body(BUCKET, lockKey)).toBeUndefined();
    });

    test("the delete is conditional on the lock's ETag", async () => {
      const release = await open().lock({ command: "apply" });
      const etag = s3.objects.get(`${BUCKET}/${lockKey}`)!.etag;
      await release();
      expect(s3.callsOf("DeleteObjectCommand")[0]!.input).toMatchObject({ Key: lockKey, IfMatch: etag });
    });

    test("a lock replaced between the read and the delete survives", async () => {
      const mine = await open().lock({ command: "apply" });
      s3.failWhen = (call) => {
        if (call.command !== "DeleteObjectCommand") return undefined;
        s3.put(BUCKET, lockKey, JSON.stringify({ id: "other", holder: "bob@ci", command: "x", since: "t", pid: 1 }));
        return undefined;
      };
      await mine();
      expect((JSON.parse(s3.body(BUCKET, lockKey)!) as LockInfo).id).toBe("other");
    });

    test("holdLock releases the lock it took", async () => {
      const store = open();
      const release = await holdLock(store, { command: "apply" });
      expect(s3.body(BUCKET, lockKey)).toBeDefined();
      await release();
      expect(s3.body(BUCKET, lockKey)).toBeUndefined();
    });
  });

  describe("endpoints", () => {
    test("are stored beside the state with the same encryption, and removed when empty", async () => {
      const store = open();
      await store.saveEndpoints('{"routes":{}}\n');
      expect(s3.callsOf("PutObjectCommand")[0]!.input).toMatchObject({ Key: "tranquilo-app/endpoints.json", ServerSideEncryption: "AES256", ContentType: "application/json" });
      expect(await store.readEndpoints()).toBe('{"routes":{}}\n');
      await store.saveEndpoints(undefined);
      expect(await store.readEndpoints()).toBeUndefined();
      await store.saveEndpoints(undefined);
    });
  });
});

describe("cloudgear state commands", () => {
  let dir: string;
  let s3: FakeS3;
  let out: string[];
  let logSpy: ReturnType<typeof spyOn>;
  const workDir = () => path.join(dir, ".cloudgear");
  const statePath = () => path.join(workDir(), "state.json");
  const store = () => new S3StateStore(location, { client: s3, cachePath: statePath(), warn: () => {}, holder: "ana@laptop" });
  const run = (sub: string | undefined, force = false) => stateCommand(sub, store(), { force, workDir: workDir(), statePath: statePath() });
  const writeLocal = (state: State) => {
    fs.mkdirSync(workDir(), { recursive: true });
    fs.writeFileSync(statePath(), serializeState(state));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-statecmd-"));
    s3 = new FakeS3();
    out = [];
    logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
  });
  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("push uploads local state and endpoints", async () => {
    writeLocal(stateWith("one"));
    fs.writeFileSync(path.join(workDir(), "endpoints.json"), '{"routes":{}}\n');
    await run("push");
    expect(JSON.parse(s3.body(BUCKET, "tranquilo-app/state.json")!)).toEqual(stateWith("one"));
    expect(s3.body(BUCKET, "tranquilo-app/endpoints.json")).toBe('{"routes":{}}\n');
    expect(out.join("\n")).toMatch(/pushed 1 entries to s3:\/\/state\.tranquilo\.art\/tranquilo-app\//);
  });

  test("push refuses to replace remote state without --force", async () => {
    s3.put(BUCKET, "tranquilo-app/state.json", serializeState(stateWith("remote")));
    writeLocal(stateWith("local"));
    await expect(run("push")).rejects.toThrow(/already holds state \(1 entries\); pass --force/);
    expect(JSON.parse(s3.body(BUCKET, "tranquilo-app/state.json")!)).toEqual(stateWith("remote"));
    await run("push", true);
    expect(JSON.parse(s3.body(BUCKET, "tranquilo-app/state.json")!)).toEqual(stateWith("local"));
    expect(out.join("\n")).toMatch(/replaced the existing remote state/);
  });

  test("push without local state says so", async () => {
    await expect(run("push")).rejects.toThrow(/there is no local state to push/);
  });

  test("pull writes state.json and endpoints.json", async () => {
    s3.put(BUCKET, "tranquilo-app/state.json", serializeState(stateWith("remote")));
    s3.put(BUCKET, "tranquilo-app/endpoints.json", '{"routes":{"GET /":"https://x"}}\n');
    await run("pull");
    expect(JSON.parse(fs.readFileSync(statePath(), "utf8"))).toEqual(stateWith("remote"));
    expect(fs.readFileSync(path.join(workDir(), "endpoints.json"), "utf8")).toBe('{"routes":{"GET /":"https://x"}}\n');
  });

  test("pull without remote state fails", async () => {
    await expect(run("pull")).rejects.toThrow(/No state at s3:\/\//);
  });

  test("unlock refuses without --force and removes the lock with it", async () => {
    await store().lock({ command: "apply" });
    await expect(run("unlock")).rejects.toThrow(/without --force/);
    expect(out.join("\n")).toMatch(/lock held by ana@laptop since \S+ \(command apply\)/);
    expect(s3.body(BUCKET, "tranquilo-app/state.lock")).toBeDefined();
    await run("unlock", true);
    expect(s3.body(BUCKET, "tranquilo-app/state.lock")).toBeUndefined();
    await run("unlock", true);
    expect(out.at(-1)).toMatch(/is not locked/);
  });

  test("show prints location, entries, version and lock without the content", async () => {
    s3.put(BUCKET, "tranquilo-app/state.json", serializeState(stateWith("secret-looking-name")));
    await store().lock({ command: "apply" });
    await run("show");
    const text = out.join("\n");
    expect(text).toMatch(/location: s3:\/\/state\.tranquilo\.art\/tranquilo-app\//);
    expect(text).toMatch(/entries: {2}1/);
    expect(text).toMatch(/version: {2}"[0-9a-f]{32}"/);
    expect(text).toMatch(/locked: {3}yes, by ana@laptop/);
    expect(text).not.toContain("secret-looking-name");
  });

  test("rejects an unknown subcommand, and a local store", async () => {
    await expect(run("frobnicate")).rejects.toThrow(/Usage: cloudgear state/);
    await expect(stateCommand("show", new LocalStateStore(statePath()), { force: false, workDir: workDir(), statePath: statePath() })).rejects.toThrow(/No remote state is configured/);
  });
});

describe("LocalStateStore", () => {
  let dir: string;
  beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-local-"))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("behaves like the state file functions", async () => {
    const file = path.join(dir, ".cloudgear", "state.json");
    const store = new LocalStateStore(file);
    expect((await store.load("app", "aws")).state).toEqual(emptyState());
    await store.save(stateWith("one"));
    expect(fs.readFileSync(file, "utf8")).toBe(serializeState(stateWith("one")));
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect((await store.load("app", "aws")).state).toEqual(stateWith("one"));
    await expect(store.load("other", "aws")).rejects.toThrow(/belongs to project "app"/);
    const release = await store.lock();
    await release();
    expect(store.describe()).toBe(file);
  });

  test("createStateStore defaults to the local file", async () => {
    const store = await createStateStore({ localFile: path.join(dir, "state.json") });
    expect(store).toBeInstanceOf(LocalStateStore);
    expect(await createStateStore({ url: "s3://bucket/p", localFile: path.join(dir, "state.json") })).toBeInstanceOf(S3StateStore);
    await expect(createStateStore({ url: "ftp://x/y", localFile: "x" })).rejects.toThrow(/s3:\/\/ scheme/);
  });
});

describe("apply with a store", () => {
  let dir: string;
  let s3: FakeS3;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-apply-"));
    s3 = new FakeS3();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("awaits an async save after every step", async () => {
    const store = new LocalStateStore(path.join(dir, "state.json"));
    const { state } = await store.load("app", "aws");
    const order: string[] = [];
    await apply(plan(baseConfig(), state), state, fakeAws().drivers, {
      log: (message) => order.push(`log ${message}`),
      save: async (s) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`saved ${Object.keys(s.entries).length}`);
        await store.save(s);
      },
    });
    expect(order.filter((o) => o.startsWith("saved"))).toEqual(["saved 1", "saved 2"]);
    expect((await store.load("app", "aws")).state).toEqual(state);
  });

  test("a rejected save stops apply and the previous remote state survives", async () => {
    const store = new S3StateStore(location, { client: s3, cachePath: path.join(dir, "state.json") });
    const { state } = await store.load("app", "aws");
    let puts = 0;
    s3.failWhen = (call) => (call.command === "PutObjectCommand" && ++puts === 2 ? s3Error("InternalError", 500) : undefined);
    await expect(apply(plan(baseConfig(), state), state, fakeAws().drivers, { save: (s) => store.save(s) })).rejects.toThrow("InternalError");
    const remote = JSON.parse(s3.body(BUCKET, "tranquilo-app/state.json")!) as State;
    expect(Object.keys(remote.entries)).toEqual(["@aws.S3.data"]);
  });
});

describe("--state on the command line", () => {
  let dir: string;
  beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-flag-"))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string> = {}) => {
    const proc = Bun.spawnSync(["bun", path.join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
      cwd: dir,
      env: { ...process.env, CLOUDGEAR_STATE: "", ...env },
    });
    return { code: proc.exitCode, err: proc.stderr.toString() };
  };

  test("state commands need a remote location", () => {
    const res = run(["state", "show"]);
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/No remote state is configured/);
  });

  test("a location that is not s3 is rejected, from the flag or the environment", () => {
    expect(run(["state", "show", "--state", "https://bucket/p"]).err).toMatch(/s3:\/\/ scheme/);
    expect(run(["state", "show"], { CLOUDGEAR_STATE: "gs://bucket/p" }).err).toMatch(/s3:\/\/ scheme/);
    expect(run(["state", "show", "--state", "s3://bucket/a/../b"], { CLOUDGEAR_STATE: "gs://x/y" }).err).toMatch(/"\.\."/);
  });
});
