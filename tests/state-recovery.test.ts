import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply, ApplyInterrupted } from "../src/deploy/apply";
import { plan } from "../src/deploy/plan";
import { serializeState, type State } from "../src/deploy/state";
import { parseS3Location, S3StateStore, STATE_CHANGED, STATE_DELETED, type LockInfo } from "../src/deploy/state-s3";
import { assertNoUnpushedLocalState, holdLock, LocalStateStore, MARKER_FILE } from "../src/deploy/state-store";
import { stateCommand } from "../src/statecmd";
import { FakeS3, s3Error } from "./fake-s3";
import { baseConfig, emptyState, fakeAws } from "./helpers";

const BUCKET = "state.tranquilo.art";
const location = parseS3Location(`s3://${BUCKET}/app/`);
const lockKey = "app/state.lock";

function stateWith(...names: string[]): State {
  const state = emptyState();
  for (const name of names) {
    state.entries[`@aws.S3.${name}`] = { kind: "resource", type: "@aws.S3", name, physical_name: name, spec: {}, outputs: {} };
  }
  return state;
}

const backups = (file: string) => fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.pre-remote`));

// The write lands but its answer is lost, then the SDK retries it.
function loseFirstResponse(s3: FakeS3, matches: (key: string) => boolean) {
  const send = s3.send.bind(s3);
  let lost = false;
  s3.send = async (command: unknown) => {
    const result = await send(command);
    const { input } = command as { input: { Key: string } };
    if ((command as object).constructor.name === "PutObjectCommand" && matches(input.Key) && !lost) {
      lost = true;
      return send(command);
    }
    return result;
  };
}

describe("remote state recovery", () => {
  let dir: string;
  let s3: FakeS3;
  let warnings: string[];
  const cache = () => path.join(dir, ".cloudgear", "state.json");
  const open = (cachePath: string | undefined = cache(), holder?: string, client = s3) =>
    new S3StateStore(location, { client, cachePath, warn: (m) => warnings.push(m), holder });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-recovery-"));
    s3 = new FakeS3();
    warnings = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe("a write whose response was lost", () => {
    test("is adopted when a later save of the same state finds it already stored", async () => {
      const store = open();
      await store.load("app", "aws");
      await store.save(stateWith("one"));
      loseFirstResponse(s3, (key) => key === "app/state.json");
      await store.save(stateWith("one", "two"));
      expect(JSON.parse(s3.body(BUCKET, "app/state.json")!)).toEqual(stateWith("one", "two"));
      await store.save(stateWith("one", "two", "three"));
    });

    test("is adopted for the first write too", async () => {
      const store = open();
      await store.load("app", "aws");
      loseFirstResponse(s3, (key) => key === "app/state.json");
      await store.save(stateWith("one"));
      await store.save(stateWith("two"));
      expect(JSON.parse(s3.body(BUCKET, "app/state.json")!)).toEqual(stateWith("two"));
    });

    test("is still refused when the stored state is someone else's", async () => {
      const store = open();
      await store.load("app", "aws");
      s3.put(BUCKET, "app/state.json", serializeState(stateWith("theirs")));
      await expect(store.save(stateWith("mine"))).rejects.toThrow(STATE_CHANGED);
    });

    test("does not make the lock look held by someone else", async () => {
      loseFirstResponse(s3, (key) => key === lockKey);
      const release = await open().lock({ command: "apply" });
      expect(s3.body(BUCKET, lockKey)).toBeDefined();
      await release();
      expect(s3.body(BUCKET, lockKey)).toBeUndefined();
    });
  });

  test("a state deleted since it was read is reported as deleted", async () => {
    const store = open();
    await store.load("app", "aws");
    await store.save(stateWith("one"));
    s3.objects.delete(`${BUCKET}/app/state.json`);
    await expect(store.save(stateWith("two"))).rejects.toThrow(STATE_DELETED);
  });

  test("a missing bucket is not mistaken for missing state", async () => {
    s3.failWhen = () => s3Error("NoSuchBucket", 404);
    await expect(open().load("app", "aws")).rejects.toThrow(/does not exist; cloudgear does not create it/);
  });

  describe("holdLock", () => {
    test("a release failure warns and never replaces the original error", async () => {
      const lock = await holdLock(open(), { command: "apply" }, { warn: (m) => warnings.push(m) });
      s3.failWhen = (call) => (call.command === "GetObjectCommand" ? s3Error("RequestTimeout", 400) : undefined);
      let seen: unknown;
      try {
        try {
          throw new Error("the apply failed");
        } finally {
          await lock.release();
        }
      } catch (err) {
        seen = err;
      }
      expect((seen as Error).message).toBe("the apply failed");
      expect(warnings[0]).toMatch(/lock not released.*RequestTimeout.*cloudgear state unlock --force/);
      expect(s3.body(BUCKET, lockKey)).toBeDefined();
    });

    test("a release that hangs times out", async () => {
      const lock = await holdLock(open(), { command: "apply" }, { warn: (m) => warnings.push(m), releaseTimeoutMs: 20 });
        const send = s3.send.bind(s3);
      s3.send = (command: unknown) => ((command as object).constructor.name === "GetObjectCommand" ? new Promise(() => {}) : send(command));
      await lock.release();
      expect(warnings[0]).toMatch(/timed out after 20 ms/);
    });

    test("only one of two concurrent holders gets the lock", async () => {
      const results = await Promise.allSettled([
        holdLock(open(undefined, "ana@laptop"), { command: "apply" }),
        holdLock(open(undefined, "bob@ci"), { command: "destroy" }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const winner = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof holdLock>>>;
      const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(String(loser.reason)).toMatch(/state is locked by/);
      await winner.value.release();
      const next = await holdLock(open(), { command: "apply" });
      await next.release();
    });

    test("a SIGINT during a step finishes and saves it, stops, and releases", async () => {
      const store = open();
      const { state } = await store.load("app", "aws");
      const lock = await holdLock(store, { command: "apply" }, { warn: (m) => warnings.push(m) });
      let saves = 0;
      let first = true;
      const err = await apply(plan(baseConfig(), state), state, fakeAws().drivers, {
        save: async (s) => {
          saves++;
          await store.save(s);
        },
        shouldStop: () => lock.signal.aborted,
        log: () => {
          if (first) process.emit("SIGINT");
          first = false;
        },
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ApplyInterrupted);
      expect(saves).toBe(1);
      expect(Object.keys((JSON.parse(s3.body(BUCKET, "app/state.json")!) as State).entries)).toEqual(["@aws.S3.data"]);
      expect(warnings[0]).toMatch(/finishing the current step/);
      await lock.release();
      expect(s3.body(BUCKET, lockKey)).toBeUndefined();
    });

    test("a second signal exits at once and says the lock stays", async () => {
      const exits: number[] = [];
      const lock = await holdLock(open(), { command: "apply" }, { warn: (m) => warnings.push(m), exit: (code) => void exits.push(code) as never });
      process.emit("SIGINT");
      process.emit("SIGTERM");
      expect(exits).toEqual([130]);
      expect(warnings.at(-1)).toMatch(/still held.*cloudgear state unlock --force/);
      expect(s3.body(BUCKET, lockKey)).toBeDefined();
      await lock.release();
    });

    test("a signal while the lock is being taken releases it afterwards", async () => {
      const send = s3.send.bind(s3);
      s3.send = async (command: unknown) => {
        if ((command as object).constructor.name === "PutObjectCommand") process.emit("SIGINT");
        return send(command);
      };
      await expect(holdLock(open(), { command: "apply" }, { warn: (m) => warnings.push(m) })).rejects.toThrow(/Interrupted before the command started/);
      expect(s3.body(BUCKET, lockKey)).toBeUndefined();
    });

    test("handlers are removed after release", async () => {
      const before = process.listenerCount("SIGINT");
      const lock = await holdLock(open(), { command: "apply" });
      expect(process.listenerCount("SIGINT")).toBe(before + 1);
      await lock.release();
      expect(process.listenerCount("SIGINT")).toBe(before);
    });
  });

  describe("forceUnlock", () => {
    test("is conditional on the lock it read", async () => {
      await open().lock({ command: "apply" });
      const etag = s3.objects.get(`${BUCKET}/${lockKey}`)!.etag;
      await open().forceUnlock();
      expect(s3.callsOf("DeleteObjectCommand").at(-1)!.input.IfMatch).toBe(etag);
    });

    test("does not delete a lock taken between the read and the delete", async () => {
      await open().lock({ command: "apply" });
      s3.failWhen = (call) => {
        if (call.command === "DeleteObjectCommand") {
          s3.failWhen = undefined;
          s3.put(BUCKET, lockKey, JSON.stringify({ id: "new", holder: "bob@ci", command: "apply", since: "t", pid: 2 }));
        }
        return undefined;
      };
      await expect(open().forceUnlock()).rejects.toThrow(/lock changed while it was being removed/);
      expect((JSON.parse(s3.body(BUCKET, lockKey)!) as LockInfo).id).toBe("new");
    });
  });

  describe("an empty remote with local state", () => {
    const writeLocal = (state: State) => {
      fs.mkdirSync(path.dirname(cache()), { recursive: true });
      fs.writeFileSync(cache(), serializeState(state));
    };

    test("mutating commands refuse, with an explicit override", async () => {
      writeLocal(stateWith("one", "two"));
      const store = open();
      const { state } = await store.load("app", "aws");
      expect(state.entries).toEqual({});
      expect(warnings[0]).toMatch(/holds 2 entries.*state push/);
      expect(() => assertNoUnpushedLocalState(store, false)).toThrow(/2 entries.*cloudgear state push.*--allow-empty-remote/);
      expect(() => assertNoUnpushedLocalState(store, true)).not.toThrow();
    });

    test("nothing is refused without local entries or without a local file", async () => {
      const store = open();
      await store.load("app", "aws");
      expect(() => assertNoUnpushedLocalState(store, false)).not.toThrow();
      writeLocal(emptyState());
      const other = open();
      await other.load("app", "aws");
      expect(() => assertNoUnpushedLocalState(other, false)).not.toThrow();
    });

    test("a remote state deleted after being mirrored warns and refuses", async () => {
      const store = open();
      await store.load("app", "aws");
      await store.save(stateWith("one"));
      s3.objects.delete(`${BUCKET}/app/state.json`);
      const later = open();
      await later.load("app", "aws");
      expect(warnings[0]).toMatch(/holds no state any more.*state push/);
      expect(() => assertNoUnpushedLocalState(later, false)).toThrow(/cloudgear state push/);
    });

    test("pushing the local state makes the next run normal", async () => {
      writeLocal(stateWith("one"));
      await stateCommand("push", open(), { force: false, workDir: path.dirname(cache()), statePath: cache(), project: "app", provider: "aws" });
      const next = open();
      expect((await next.load("app", "aws")).state).toEqual(stateWith("one"));
      expect(() => assertNoUnpushedLocalState(next, false)).not.toThrow();
    });
  });

  describe("local mode after remote use", () => {
    test("refuses while the marker exists and works once it is deleted", async () => {
      const store = open();
      await store.load("app", "aws");
      await store.save(stateWith("one"));
      const marker = path.join(path.dirname(cache()), MARKER_FILE);
      expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toMatchObject({ location: "s3://state.tranquilo.art/app/" });
      const local = new LocalStateStore(cache());
      await expect(local.load("app", "aws")).rejects.toThrow(/this directory uses remote state at s3:\/\/state\.tranquilo\.art\/app\/; pass --state s3:\/\/state\.tranquilo\.art\/app\/ or delete .*state\.remote\.json/);
      await expect(local.save(stateWith("x"))).rejects.toThrow(/uses remote state/);
      fs.rmSync(marker);
      expect((await local.load("app", "aws")).state).toEqual(stateWith("one"));
    });
  });

  describe("the local copy", () => {
    test("an edited cache is backed up before the next remote load replaces it", async () => {
      const store = open();
      await store.load("app", "aws");
      await store.save(stateWith("one"));
      fs.writeFileSync(cache(), serializeState(stateWith("edited")));
      const later = open();
      await later.load("app", "aws");
      expect(warnings[0]).toMatch(/differs from the remote state/);
      expect(backups(cache())).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(path.join(path.dirname(cache()), backups(cache())[0]!), "utf8"))).toEqual(stateWith("edited"));
    });

    test("switching prefix keeps every earlier backup", async () => {
      fs.mkdirSync(path.dirname(cache()), { recursive: true });
      fs.writeFileSync(cache(), serializeState(stateWith("orig")));
      s3.put(BUCKET, "a/state.json", serializeState(emptyState()));
      s3.put(BUCKET, "b/state.json", serializeState(stateWith("b")));
      const at = (prefix: string) => new S3StateStore(parseS3Location(`s3://${BUCKET}/${prefix}/`), { client: s3, cachePath: cache(), warn: () => {} });
      await at("a").load("app", "aws");
      await at("b").load("app", "aws");
      const kept = backups(cache()).map((name) => fs.readFileSync(path.join(path.dirname(cache()), name), "utf8"));
      expect(kept).toHaveLength(2);
      expect(kept.some((text) => text.includes("orig"))).toBe(true);
      expect(kept.some((text) => !text.includes("orig") && text.includes('"entries": {}'))).toBe(true);
    });

    test("the marker records the sha256 of what was mirrored", async () => {
      const store = open();
      await store.load("app", "aws");
      await store.save(stateWith("one"));
      const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(cache()), MARKER_FILE), "utf8"));
      expect(marker.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("state push", () => {
    test("checks the local state against the config's project and provider", async () => {
      fs.mkdirSync(path.dirname(cache()), { recursive: true });
      fs.writeFileSync(cache(), serializeState(stateWith("one")));
      const options = { force: false, workDir: path.dirname(cache()), statePath: cache(), provider: "aws" };
      await expect(stateCommand("push", open(), { ...options, project: "other" })).rejects.toThrow(/belongs to project "app" \(aws\), config is "other" \(aws\)/);
      expect(s3.body(BUCKET, "app/state.json")).toBeUndefined();
    });
  });
});
