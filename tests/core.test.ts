import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as blob from "@cloudgear/blob";
import * as functions from "@cloudgear/functions";
import { allOf, anyOf, authenticated, claim, guard, not, type Check } from "@cloudgear/core";
import * as core from "@cloudgear/core";
import { analyzeApp } from "../src/analyze/app";
import { generate } from "../src/generate";
import { invoke } from "../packages/functions/http";
import { createHandler } from "@cloudgear/functions/drivers/aws";

setDefaultTimeout(30_000);

const fixture = path.join(import.meta.dir, "fixtures", "router", "core", "guarded.ts");
const admin = { auth: { subject: "root", claims: { role: "admin", level: 3 } } };
const reader = { auth: { subject: "pat", claims: { role: "reader", level: 1 } } };

const status = (value: unknown) => (value as { status?: number }).status;
const body = (value: unknown) => (value as { body?: unknown }).body;

describe("@cloudgear/core re-exports", () => {
  test("the decorators and helpers are the packages' own, not copies", () => {
    expect(core.policy).toBe(blob.policy);
    expect(core.permissions).toBe(blob.permissions);
    expect(core.grant).toBe(blob.grant);
    expect(core.schedule).toBe(functions.schedule);
    expect(core.cron).toBe(functions.cron);
    expect(core.response).toBe(functions.response);
    expect(core.jwtAuth).toBe(functions.jwtAuth);
  });
});

describe("checks", () => {
  test("authenticated needs a caller", async () => {
    expect(await authenticated()({}, admin)).toBe(true);
    expect(await authenticated()({}, {})).toBe(false);
  });

  test("claim compares a value, runs a predicate, or checks presence", async () => {
    expect(await claim("role", "admin")({}, admin)).toBe(true);
    expect(await claim("role", "admin")({}, reader)).toBe(false);
    expect(await claim("level", (v) => (v as number) >= 2)({}, admin)).toBe(true);
    expect(await claim("level", (v) => (v as number) >= 2)({}, reader)).toBe(false);
    expect(await claim("role")({}, reader)).toBe(true);
    expect(await claim("missing")({}, reader)).toBe(false);
    expect(await claim("role", "admin")({}, {})).toBe(false);
    expect(await claim("toString")({}, reader)).toBe(false);
  });

  test("allOf, anyOf and not combine checks, including async ones", async () => {
    const yes: Check = async () => true;
    const no: Check = () => false;
    expect(await allOf(yes, yes)({}, {})).toBe(true);
    expect(await allOf(yes, no)({}, {})).toBe(false);
    expect(await allOf()({}, {})).toBe(true);
    expect(await anyOf(no, yes)({}, {})).toBe(true);
    expect(await anyOf(no, no)({}, {})).toBe(false);
    expect(await anyOf()({}, {})).toBe(false);
    expect(await not(no)({}, {})).toBe(true);
    expect(await not(yes)({}, {})).toBe(false);
  });

  test("checks stop at the first refusal", async () => {
    const calls: string[] = [];
    const first: Check = () => (calls.push("first"), false);
    const second: Check = () => (calls.push("second"), true);
    await allOf(first, second)({}, {});
    expect(calls).toEqual(["first"]);
  });
});

describe("@guard", () => {
  class Service {
    constructor(readonly tag: string) {}

    @guard(claim("role", "admin"))
    async secret(input: { id: string }, _context: core.RequestContext) {
      return { id: input.id, tag: this.tag };
    }

    @guard(authenticated(), claim("level", (v) => (v as number) > 1))
    static async both(_input?: unknown, _context?: core.RequestContext) {
      return "ok";
    }
  }

  test("runs the method with its arguments and `this` when the checks pass", async () => {
    expect(await new Service("t1").secret({ id: "7" }, admin)).toEqual({ id: "7", tag: "t1" });
    expect(await Service.both(undefined as never, admin)).toBe("ok");
  });

  test("answers 401 without a caller and 403 with one the checks refuse", async () => {
    const anonymous = await new Service("t").secret({ id: "7" }, {});
    expect(status(anonymous)).toBe(401);
    expect(body(anonymous)).toEqual({ error: "Unauthorized" });
    expect((anonymous as unknown as { headers: Record<string, string> }).headers["www-authenticate"]).toBe("Bearer");
    const refused = await new Service("t").secret({ id: "7" }, reader);
    expect(status(refused)).toBe(403);
    expect(body(refused)).toEqual({ error: "Forbidden" });
    expect(status(await Service.both(undefined as never, reader))).toBe(403);
  });

  test("a missing context is treated as no caller", async () => {
    expect(status(await new Service("t").secret({ id: "1" }, undefined as never))).toBe(401);
  });

  test("a check that throws is not turned into a refusal", async () => {
    class Broken {
      @guard(async () => {
        throw new Error("directory down");
      })
      static async run(_input?: unknown, _context?: core.RequestContext) {
        return "ran";
      }
    }
    await expect(Broken.run(undefined as never, admin)).rejects.toThrow("directory down");
  });

  test("the method is not called when the guard refuses", async () => {
    let called = 0;
    class Counted {
      @guard(() => false)
      static async run(_input?: unknown, _context?: core.RequestContext) {
        called++;
      }
    }
    await Counted.run(undefined as never, admin);
    expect(called).toBe(0);
  });
});

describe("@guard with the router's calling conventions", () => {
  class Routes {
    @guard(claim("role", "admin"))
    static async helper(input: { id: string }, respond: typeof core.response, _context?: core.RequestContext) {
      return respond({ id: input.id }, { status: 201 });
    }

    @guard(authenticated())
    static sync(_input?: unknown, _context?: core.RequestContext) {
      return { sync: true };
    }

    @guard(authenticated())
    static async scheduled(_input?: unknown, _context?: core.RequestContext) {
      return { ran: true };
    }
  }

  test("a route with the response option gets the context from the last argument and keeps the helper", async () => {
    const ok = await invoke(Routes.helper, { id: "1" }, admin, { response: "helper" });
    expect(ok.status).toBe(201);
    expect(JSON.parse(ok.body)).toEqual({ id: "1" });
    expect((await invoke(Routes.helper, { id: "1" }, reader, { response: "helper" })).status).toBe(403);
    expect((await invoke(Routes.helper, { id: "1" }, {}, { response: "helper" })).status).toBe(401);
  });

  test("a synchronous method works and is awaited by the router", async () => {
    const result = await invoke(Routes.sync, {}, admin);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ sync: true });
  });

  test("the wrapper keeps the method's name, so routes keep their default names", () => {
    expect(Routes.helper.name).toBe("helper");
    expect(Routes.sync.name).toBe("sync");
  });

  test("a scheduled run has no caller, so a guard refuses it and the run fails", async () => {
    const handler = createHandler(Routes.scheduled, []);
    const log = console.error;
    console.error = () => {};
    try {
      await expect(handler({ source: "aws.events", time: "2026-10-26T10:00:00Z" })).rejects.toThrow(/Scheduled run failed with status 401/);
    } finally {
      console.error = log;
    }
  });

  test("claims are optional on a principal, and checks short-circuit and fail closed", async () => {
    expect(await claim("role")({}, { auth: { subject: "s" } as never })).toBe(false);
    const calls: string[] = [];
    await anyOf(() => (calls.push("a"), true), () => (calls.push("b"), true))({}, {});
    expect(calls).toEqual(["a"]);
    await expect(not(async () => Promise.reject(new Error("check failed")))({}, {})).rejects.toThrow("check failed");
  });
});

describe("guarded functions in an app", () => {
  test("the analyzer sees @policy through the re-export, and a guard's own store use counts", () => {
    const model = analyzeApp(fixture);
    const uses = Object.fromEntries(model.functions.map((f) => [f.name, [...f.uses.values()].map((u) => [u.resource, [...u.accesses].sort()])]));
    expect(uses).toEqual({
      "Reports-read": [["reports", ["read"]]],
      "Reports-audit": [["admins", ["list", "read"]]],
    });
  });

  test("the bundle enforces the guard: 401 with no caller, 403 for the wrong role, 200 for an admin", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-"));
    await generate({ entry: fixture, configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "guarded" });
    const script = `
      const { handler } = await import(${JSON.stringify(path.join(dir, "b/Reports-read/index.mjs"))});
      const call = async (context) => {
        const res = await handler({
          rawPath: "/reports/a", headers: { "content-type": "application/vnd.cloudgear.invoke+json" },
          body: JSON.stringify({ input: { id: "a" }, context }), requestContext: { http: { method: "POST" } },
        });
        return res.statusCode;
      };
      console.log(JSON.stringify([await call({}), await call({ auth: { subject: "p", claims: { role: "reader" } } }), await call({ auth: { subject: "r", claims: { role: "admin" } } })]));
    `;
    const proc = Bun.spawnSync(["node", "--input-type=module", "-e", script], {
      env: { ...process.env, CLOUDGEAR_BLOB_DRIVER: "memory", AWS_LAMBDA_FUNCTION_NAME: "x" },
      cwd: dir,
    });
    expect(proc.stderr.toString()).toBe("");
    expect(JSON.parse(proc.stdout.toString())).toEqual([401, 403, 200]);
  });
});
