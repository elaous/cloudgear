import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "@cloudgear/database";
import { analyzeApp } from "../src/analyze/app";
import { apply, type Drivers } from "../src/deploy/apply";
import { neonApiKey, neonDrivers } from "../src/deploy/neon";
import { plan } from "../src/deploy/plan";
import { stateKey } from "../src/deploy/state";
import { decodeConfig, type CloudgearConfig } from "../src/config/schema";
import { generate } from "../src/generate";
import { baseConfig, emptyState } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "database", `${name}.ts`);
const SECRET_URI = "postgres://owner:s3cr3t-password@ep-1.neon.tech/neondb";

describe("Database", () => {
  test("validates the provider, name, region and version without side effects", () => {
    expect(new Database("neon", "app", { region: "aws-eu-central-1", postgres: 16 }).name).toBe("app");
    expect(() => new Database("rds" as "neon", "app")).toThrow(/not supported yet/);
    expect(() => new Database("neon", "")).toThrow(/Invalid database name/);
    expect(() => new Database("neon", "app", { region: "Europe" })).toThrow(/Invalid Neon region/);
    expect(() => new Database("neon", "app", { postgres: 9 as 17 })).toThrow(/Unsupported Postgres version/);
  });
});

describe("analysis", () => {
  test("databases become @neon.Database resources with their options", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "database-"));
    const configPath = path.join(dir, "c.prototxt");
    const { config } = await generate({ entry: fixture("basic"), configPath, buildDir: path.join(dir, "b"), project: "app" });
    expect(config.resource.map((r) => [r.name, r.type, r.physical_name, r.dry, r.options])).toEqual([
      ["db.tranquilo-app", "@neon.Database", "tranquilo-app", false, { region: "aws-us-east-1", pg_version: "17", allow_destroy: "true" }],
      ["db.analytics", "@neon.Database", "analytics", false, {}],
    ]);
    expect(decodeConfig(fs.readFileSync(configPath, "utf8")).resource.map((r) => r.name)).toEqual(["db.tranquilo-app", "db.analytics"]);
  });

  test("the model lists every declared database", () => {
    expect(analyzeApp(fixture("basic")).databases.map((d) => [d.name, d.region, d.postgres, d.allowDestroy])).toEqual([
      ["tranquilo-app", "aws-us-east-1", 17, true],
      ["analytics", undefined, undefined, false],
    ]);
  });

  test("a database declared twice, with an unsupported version, or with a computed flag is rejected", () => {
    expect(() => analyzeApp(fixture("duplicate"))).toThrow(/Database "same" is also declared at/);
    expect(() => analyzeApp(fixture("bad-version"))).toThrow(/Unsupported Postgres version 9/);
    expect(() => analyzeApp(fixture("dynamic-flag"))).toThrow(/allowDestroy must be true or false/);
  });
});

interface Fake {
  projects: { id: string; name: string; region_id: string; pg_version: number }[];
  calls: string[];
  logs: string[];
}

function fakeNeon(initial: Fake["projects"] = [], opts: { pageSize?: number } = {}) {
  const state: Fake = { projects: [...initial], calls: [], logs: [] };
  const pageSize = opts.pageSize ?? 100;
  const fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    state.calls.push(`${method} ${u.pathname}${u.search}`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key-123");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (method === "GET" && u.pathname === "/api/v2/projects") {
      const start = Number(u.searchParams.get("cursor") ?? 0);
      const page = state.projects.slice(start, start + pageSize);
      return json(200, { projects: page, pagination: { cursor: String(start + pageSize) }, connection_uris: [{ connection_uri: SECRET_URI }] });
    }
    if (method === "POST" && u.pathname === "/api/v2/projects") {
      const body = JSON.parse(String(init.body)).project;
      const project = { id: `p-${state.projects.length + 1}`, name: body.name, region_id: body.region_id ?? "aws-us-east-2", pg_version: body.pg_version ?? 17 };
      state.projects.push(project);
      return json(201, { project, connection_uris: [{ connection_uri: SECRET_URI }] });
    }
    const id = u.pathname.split("/").pop()!;
    const found = state.projects.find((p) => p.id === id);
    if (method === "GET") return found ? json(200, { project: found, connection_uris: [{ connection_uri: SECRET_URI }] }) : json(404, { message: "project not found" });
    if (method === "DELETE") {
      if (!found) return json(404, { message: "project not found" });
      state.projects = state.projects.filter((p) => p.id !== id);
      return json(200, { project: found });
    }
    return json(500, { message: "unexpected" });
  }) as unknown as typeof globalThis.fetch;
  const drivers = neonDrivers({ apiKey: "key-123", fetch, log: (m) => state.logs.push(m) });
  return { state, drivers };
}

const configWith = (options?: Record<string, string>): CloudgearConfig =>
  baseConfig({ resource: [{ name: "db.app", type: "@neon.Database", physical_name: "app", dry: false, source: "setup.ts:1", ...(options ? { options } : {}) }], function: [] });

async function applyConfig(config: CloudgearConfig, state: ReturnType<typeof emptyState>, drivers: Drivers) {
  await apply(plan(config, state), state, drivers, { save: () => {}, log: () => {} });
}

describe("neon driver", () => {
  test("creates a missing project with the wanted region and version", async () => {
    const { state, drivers } = fakeNeon();
    const saved = emptyState();
    await applyConfig(configWith({ region: "aws-eu-central-1", pg_version: "16" }), saved, drivers);
    expect(state.projects).toEqual([{ id: "p-1", name: "app", region_id: "aws-eu-central-1", pg_version: 16 }]);
    expect(saved.entries[stateKey({ type: "@neon.Database", name: "db.app" })]!.outputs).toEqual({ project_id: "p-1", region: "aws-eu-central-1", pg_version: "16" });
  });

  test("adopts a project that already has the name instead of creating a second one", async () => {
    const { state, drivers } = fakeNeon([{ id: "old", name: "app", region_id: "aws-us-east-1", pg_version: 17 }]);
    const saved = emptyState();
    await applyConfig(configWith({ region: "aws-us-east-1" }), saved, drivers);
    expect(state.projects).toHaveLength(1);
    expect(state.calls.some((c) => c.startsWith("POST"))).toBe(false);
    expect(saved.entries[stateKey({ type: "@neon.Database", name: "db.app" })]!.outputs.project_id).toBe("old");
    expect(state.logs).toEqual(["adopted existing Neon project app"]);
  });

  test("refuses to adopt a project whose region or version differs", async () => {
    const { drivers } = fakeNeon([{ id: "old", name: "app", region_id: "aws-us-east-1", pg_version: 15 }]);
    await expect(applyConfig(configWith({ pg_version: "17" }), emptyState(), drivers)).rejects.toThrow(/Postgres is 15, not 17/);
    await expect(applyConfig(configWith({ region: "aws-eu-central-1" }), emptyState(), drivers)).rejects.toThrow(/region is aws-us-east-1, not aws-eu-central-1/);
  });

  test("refuses two projects with the same name, and finds one across pages", async () => {
    const dupes = fakeNeon([
      { id: "a", name: "app", region_id: "aws-us-east-1", pg_version: 17 },
      { id: "b", name: "app", region_id: "aws-us-east-1", pg_version: 17 },
    ]);
    await expect(applyConfig(configWith(), emptyState(), dupes.drivers)).rejects.toThrow(/2 Neon projects are named "app"/);

    const many = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: i === 4 ? "app" : `other-${i}`, region_id: "aws-us-east-1", pg_version: 17 }));
    const paged = fakeNeon(many, { pageSize: 2 });
    const saved = emptyState();
    await applyConfig(configWith(), saved, paged.drivers);
    expect(saved.entries[stateKey({ type: "@neon.Database", name: "db.app" })]!.outputs.project_id).toBe("p4");
    expect(paged.state.projects).toHaveLength(5);
  });

  test("a second apply changes nothing, and an immutable change fails clearly", async () => {
    const { state, drivers } = fakeNeon();
    const saved = emptyState();
    await applyConfig(configWith({ pg_version: "16" }), saved, drivers);
    expect(plan(configWith({ pg_version: "16" }), saved).every((a) => a.op === "noop")).toBe(true);
    await expect(applyConfig(configWith({ pg_version: "17" }), saved, drivers)).rejects.toThrow(/Postgres is 16, not 17; Neon cannot change that in place/);
    expect(state.projects).toHaveLength(1);
  });

  test("never logs or stores a connection URI or password", async () => {
    const { state, drivers } = fakeNeon();
    const saved = emptyState();
    await applyConfig(configWith(), saved, drivers);
    await applyConfig(configWith({ pg_version: "17" }), saved, drivers).catch(() => {});
    expect(JSON.stringify(saved)).not.toContain("s3cr3t");
    expect(state.logs.join("\n")).not.toContain("s3cr3t");
    expect(JSON.stringify(saved)).not.toContain("postgres://");
  });

  test("destroy refuses a database that is not marked allowDestroy, and deletes one that is", async () => {
    const guarded = fakeNeon();
    const savedGuarded = emptyState();
    await applyConfig(configWith(), savedGuarded, guarded.drivers);
    await expect(applyConfig(baseConfig({ resource: [], function: [] }), savedGuarded, guarded.drivers)).rejects.toThrow(/Refusing to delete Neon project "app"/);
    expect(guarded.state.projects).toHaveLength(1);

    const open = fakeNeon();
    const savedOpen = emptyState();
    await applyConfig(configWith({ allow_destroy: "true" }), savedOpen, open.drivers);
    await applyConfig(baseConfig({ resource: [], function: [] }), savedOpen, open.drivers);
    expect(open.state.projects).toEqual([]);
    expect(savedOpen.entries).toEqual({});
  });

  test("deleting a project that is already gone is not an error", async () => {
    const { state, drivers } = fakeNeon();
    const saved = emptyState();
    await applyConfig(configWith({ allow_destroy: "true" }), saved, drivers);
    state.projects = [];
    await applyConfig(baseConfig({ resource: [], function: [] }), saved, drivers);
    expect(saved.entries).toEqual({});
  });

  test("API errors name the call and status but not the key", async () => {
    const failing = neonDrivers({
      apiKey: "key-123",
      fetch: (async () => new Response(JSON.stringify({ message: "invalid token" }), { status: 401 })) as unknown as typeof fetch,
      log: () => {},
    });
    const error = await applyConfig(configWith(), emptyState(), failing).catch((e: Error) => e);
    expect((error as Error).message).toBe("Neon API GET /projects failed: 401 invalid token");
  });

  test("adopt records the desired spec only when the project matches", async () => {
    const { drivers } = fakeNeon([{ id: "old", name: "app", region_id: "aws-us-east-1", pg_version: 17 }]);
    const [entry] = plan(configWith({ region: "aws-us-east-1" }), emptyState()).map((a) => a.desired!);
    const ok = await drivers["@neon.Database"]!.adopt!(entry!, { entry: () => undefined });
    expect(ok!.spec).toEqual(entry!.spec);
    const [other] = plan(configWith({ region: "aws-eu-central-1" }), emptyState()).map((a) => a.desired!);
    const mismatch = await drivers["@neon.Database"]!.adopt!(other!, { entry: () => undefined });
    expect(mismatch!.spec).toEqual({ physical_name: "app" });
    expect(mismatch!.notes![0]).toMatch(/region is aws-us-east-1, not aws-eu-central-1/);
    const none = await fakeNeon().drivers["@neon.Database"]!.adopt!(entry!, { entry: () => undefined });
    expect(none).toBeUndefined();
  });
});

describe("NEON_API_KEY", () => {
  test("is required, trimmed, and never echoed in the error", () => {
    expect(() => neonApiKey({})).toThrow(/Set NEON_API_KEY/);
    expect(() => neonApiKey({ NEON_API_KEY: "  " })).toThrow(/Set NEON_API_KEY/);
    expect(neonApiKey({ NEON_API_KEY: " abc " })).toBe("abc");
  });
});
