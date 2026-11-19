import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeApp } from "../src/analyze/app";
import { apply, type Drivers } from "../src/deploy/apply";
import { gcpDrivers } from "../src/deploy/gcp";
import { serviceAccountIdFor } from "../src/deploy/gcp/functions";
import { GcpApiError, httpFor, toApiError, type GcpHttp } from "../src/deploy/gcp/http";
import { plan } from "../src/deploy/plan";
import { stateKey } from "../src/deploy/state";
import { gcpFunctionIdFor } from "../src/names";
import { validateOptions } from "../src/providers";
import type { CloudgearConfig } from "../src/config/schema";
import { generate } from "../src/generate";
import { baseConfig, emptyState, fn } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "gcp", `${name}.ts`);
const FUNCTIONS = "https://cloudfunctions.googleapis.com/v2";
const NAME = "projects/my-proj-123/locations/us-central1/functions/app-foo";
const SA = "cg-app-foo@my-proj-123.iam.gserviceaccount.com";
const KEY = stateKey({ type: "@gcp.CloudFunction", name: "foo" });

interface Live {
  state: string;
  env: Record<string, string>;
  memory: string;
  timeout: number;
  invokers: string[];
  email: string;
}

function fakeGoogle(opts: { existingAccounts?: string[]; failBuild?: string; propagationFailures?: number; polls?: number; functions?: Record<string, Partial<Live>> } = {}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const uploads: { url: string; headers: Record<string, string>; text: string }[] = [];
  const sleeps: number[] = [];
  const accounts = new Set<string>(opts.existingAccounts ?? []);
  const live = new Map<string, Live>(Object.entries(opts.functions ?? {}).map(([name, f]) => [name, { state: "ACTIVE", env: {}, memory: "256M", timeout: 60, invokers: [], email: SA, ...f }]));
  const operations = new Map<string, { polls: number; error?: string }>();
  let failures = opts.propagationFailures ?? 0;
  let ops = 0;
  const fail = (status: number, message: string) => new GcpApiError(status, `${message} (HTTP ${status})`);
  const startOperation = (error?: string) => {
    const name = `operations/op${++ops}`;
    operations.set(name, { polls: opts.polls ?? 2, ...(error ? { error } : {}) });
    return { name, done: false };
  };
  const http: GcpHttp = {
    async request(method, url, body?: any) {
      calls.push({ method, url, ...(body !== undefined ? { body } : {}) });
      const iam = url.match(/^https:\/\/iam\.googleapis\.com\/v1\/projects\/([^/]+)\/serviceAccounts(?:\/(.+))?$/);
      if (iam) {
        if (method === "POST") {
          const email = `${body.accountId}@${iam[1]}.iam.gserviceaccount.com`;
          if (accounts.has(email)) throw fail(409, "Service account already exists");
          accounts.add(email);
          return { email };
        }
        if (!accounts.delete(iam[2]!)) throw fail(404, "Service account not found");
        return {};
      }
      const op = url.match(/^https:\/\/cloudfunctions\.googleapis\.com\/v2\/(operations\/.+)$/);
      if (op) {
        const found = operations.get(op[1]!)!;
        found.polls--;
        return found.polls > 0 ? { name: op[1], done: false } : { name: op[1], done: true, ...(found.error ? { error: { message: found.error } } : {}) };
      }
      if (url.endsWith(":generateUploadUrl")) return { uploadUrl: "https://storage.example/upload/abc", storageSource: { bucket: "gcf-sources", object: "abc.zip", generation: "7" } };
      const create = url.match(/\/functions\?functionId=(.+)$/);
      if (create) {
        if (failures > 0) {
          failures--;
          throw fail(400, `Service account ${body.serviceConfig.serviceAccountEmail} does not exist`);
        }
        const id = create[1]!;
        const full = `projects/my-proj-123/locations/us-central1/functions/${id}`;
        live.set(full, { state: opts.failBuild ? "FAILED" : "ACTIVE", env: body.serviceConfig.environmentVariables, memory: body.serviceConfig.availableMemory, timeout: body.serviceConfig.timeoutSeconds, invokers: [], email: body.serviceConfig.serviceAccountEmail });
        return startOperation(opts.failBuild);
      }
      const iamPolicy = url.match(/\/functions\/([^/:?]+):(getIamPolicy|setIamPolicy)$/);
      if (iamPolicy) {
        const found = [...live.entries()].find(([n]) => n.endsWith(`/${iamPolicy[1]}`))?.[1];
        if (!found) throw fail(404, "Function not found");
        if (iamPolicy[2] === "getIamPolicy") return { etag: "e1", bindings: found.invokers.length ? [{ role: "roles/cloudfunctions.invoker", members: found.invokers }] : [] };
        found.invokers = (body.policy.bindings.find((b: { role: string }) => b.role === "roles/cloudfunctions.invoker")?.members ?? []) as string[];
        return {};
      }
      const one = url.match(/\/(projects\/[^?]+\/functions\/[^?:]+)(\?updateMask=(.+))?$/);
      if (one) {
        const found = live.get(one[1]!);
        if (method === "GET") {
          if (!found) throw fail(404, "Function not found");
          return { state: found.state, url: `https://app-foo-abc-uc.a.run.app`, serviceConfig: { serviceAccountEmail: found.email, uri: "https://app-foo-abc-uc.a.run.app" }, ...(found.state === "FAILED" ? { stateMessages: [{ message: "build failed" }] } : {}) };
        }
        if (method === "PATCH") {
          if (!found) throw fail(404, "Function not found");
          if (body.serviceConfig?.environmentVariables) found.env = body.serviceConfig.environmentVariables;
          if (body.serviceConfig?.availableMemory) found.memory = body.serviceConfig.availableMemory;
          if (body.serviceConfig?.timeoutSeconds) found.timeout = body.serviceConfig.timeoutSeconds;
          return startOperation();
        }
        if (method === "DELETE") {
          if (!found) throw fail(404, "Function not found");
          live.delete(one[1]!);
          return startOperation();
        }
      }
      throw new Error(`unexpected ${method} ${url}`);
    },
    async upload(url, data, headers) {
      uploads.push({ url, headers, text: Buffer.from(data).toString("latin1") });
    },
  };
  const logs: string[] = [];
  const build = (region: string | null = "us-central1"): Drivers =>
    gcpDrivers({
      storage: () => {
        throw new Error("unused");
      },
      defaultProject: async () => undefined,
      labels: { "cloudgear:project": "app" },
      log: (m) => void logs.push(m),
      env: {},
      functions: { http, region: region ?? undefined, readBundle: () => new TextEncoder().encode("export const handler = () => {};"), readIncluded: () => [{ name: "dist/index.html", data: new TextEncoder().encode("<html>") }], sleep: async (ms) => void sleeps.push(ms) },
    });
  return { calls, uploads, sleeps, accounts, live, logs, drivers: build(), build };
}

const spec = (overrides: Record<string, unknown> = {}) => fn({ type: "@gcp.CloudFunction", physical_name: "app-foo", runtime: "nodejs22", timeout_s: 60, permission: [], env: [{ key: "GREETING", value: "hi" }], options: { project: "my-proj-123" }, ...overrides });
const configWith = (overrides: Record<string, unknown> = {}, authenticated: "iam" | "none" = "none"): CloudgearConfig => baseConfig({ provider: "gcp", resource: [], function: [spec(overrides)], authenticated });
const empty = () => baseConfig({ provider: "gcp", resource: [], function: [] });

async function applyConfig(config: CloudgearConfig, state: ReturnType<typeof emptyState>, drivers: Drivers) {
  await apply(plan(config, state), state, drivers, { save: () => {}, log: () => {} });
}

describe("naming", () => {
  test("function and service account ids follow Google's rules", () => {
    expect(gcpFunctionIdFor("tranquilo-app", "api_items")).toBe("tranquilo-app-api-items");
    expect(gcpFunctionIdFor("App", "GET /v/{slug}")).toBe("app-get-v-slug");
    expect(gcpFunctionIdFor("1app", "x")).toBe("f-1app-x");
    const long = gcpFunctionIdFor("p".repeat(50), "sessions-and-other-things-in-a-long-name");
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    const sa = serviceAccountIdFor("tranquilo-app-api-items-with-a-long-suffix");
    expect(sa.length).toBeLessThanOrEqual(30);
    expect(sa).toMatch(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
    expect(serviceAccountIdFor("a".repeat(29))).not.toContain("--");
  });
});

describe("analysis", () => {
  test("a GCP router gives its functions the project, a valid id and the region", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gcpfn-"));
    const { config } = await generate({ entry: fixture("function"), configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "My_App" });
    expect(config.provider).toBe("gcp");
    expect(config.region).toBe("us-central1");
    expect(config.function.map((f) => [f.name, f.type, f.physical_name, f.options])).toEqual([["ping", "@gcp.CloudFunction", "my-app-ping", { project: "my-proj-123" }]]);
  });

  test("a bad region, a project on a non-GCP router and a project clash are errors", () => {
    expect(() => analyzeApp(fixture("function-aws-region"))).toThrow(/"us-east-1" is not a GCP region such as "us-central1"/);
    expect(() => analyzeApp(fixture("function-aws-project"))).toThrow(/the project option is for GCP routers/);
    expect(() => analyzeApp(fixture("function-project-clash"))).toThrow(/give the project option or functionOptions\.project, not both/);
  });
});

describe("cloud functions driver", () => {
  test("creates a service account, uploads the code and deploys a public function", async () => {
    const google = fakeGoogle();
    const state = emptyState();
    await applyConfig(configWith(), state, google.drivers);
    expect(google.calls[0]).toMatchObject({ method: "POST", url: "https://iam.googleapis.com/v1/projects/my-proj-123/serviceAccounts", body: { accountId: "cg-app-foo" } });
    expect(google.uploads[0]!.headers).toEqual({ "content-type": "application/zip" });
    expect(google.uploads[0]!.text).toContain("index.mjs");
    expect(google.uploads[0]!.text).toContain("package.json");
    expect(google.uploads[0]!.text).toContain("dist/index.html");
    const create = google.calls.find((c) => c.url.includes("functions?functionId=app-foo"))!;
    expect(create.body).toMatchObject({
      environment: "GEN_2",
      labels: { cloudgear_project: "app", cloudgear_resource: "foo" },
      buildConfig: { runtime: "nodejs22", entryPoint: "handler", source: { storageSource: { bucket: "gcf-sources", object: "abc.zip", generation: "7" } } },
      serviceConfig: { availableMemory: "256M", timeoutSeconds: 60, environmentVariables: { GREETING: "hi" }, serviceAccountEmail: SA, ingressSettings: "ALLOW_ALL" },
    });
    expect(google.sleeps.length).toBeGreaterThan(0);
    expect(google.live.get(NAME)!.invokers).toEqual(["allUsers"]);
    expect(state.entries[KEY]!.outputs).toEqual({ name: NAME, url: "https://app-foo-abc-uc.a.run.app", project: "my-proj-123", region: "us-central1", service_account: SA, service_account_created: "true" });
    expect(plan(configWith(), state).every((a) => a.op === "noop")).toBe(true);
  });

  test("an IAM-protected function is not opened to everyone", async () => {
    const google = fakeGoogle();
    await applyConfig(configWith({ auth: "iam" }, "iam"), emptyState(), google.drivers);
    expect(google.calls.some((c) => c.url.includes("IamPolicy"))).toBe(false);
    expect(google.live.get(NAME)!.invokers).toEqual([]);
  });

  test("environment options, max instances and a resource's output are applied", async () => {
    const google = fakeGoogle();
    const state = emptyState();
    state.entries["@aws.Other/x"] = { kind: "resource", type: "@aws.Other", name: "x", physical_name: "x", spec: {}, outputs: { endpoint: "10.0.0.5:6379" }, deps: [] } as never;
    await applyConfig(configWith({ env: [{ key: "CACHE", value_from: "x", output: "endpoint" }], options: { project: "my-proj-123", max_instances: "5", "env.EXTRA": "1" }, memory_mb: 512, timeout_s: 30 }), state, google.drivers).catch(() => undefined);
    const direct = google.drivers["@gcp.CloudFunction"]!;
    const entry = plan(configWith({ env: [{ key: "GREETING", value: "hi" }], options: { project: "my-proj-123", max_instances: "5", "env.EXTRA": "1" }, memory_mb: 512, timeout_s: 30 }), emptyState()).find((a) => a.type === "@gcp.CloudFunction")!.desired!;
    await direct.create(entry, { entry: () => undefined });
    const create = google.calls.filter((c) => c.url.includes("functionId=")).at(-1)!;
    expect(create.body.serviceConfig).toMatchObject({ availableMemory: "512M", timeoutSeconds: 30, maxInstanceCount: 5, environmentVariables: { GREETING: "hi", EXTRA: "1" } });
  });

  test("a service account that already exists is used, and not deleted with the function", async () => {
    const google = fakeGoogle({ existingAccounts: [SA] });
    const state = emptyState();
    await applyConfig(configWith(), state, google.drivers);
    expect(state.entries[KEY]!.outputs.service_account_created).toBe("false");
    await applyConfig(empty(), state, google.drivers);
    expect(google.calls.some((c) => c.method === "DELETE" && c.url.includes("serviceAccounts"))).toBe(false);
    expect(google.accounts.has(SA)).toBe(true);
  });

  test("a service account that is not usable yet is retried", async () => {
    const google = fakeGoogle({ propagationFailures: 2 });
    await applyConfig(configWith(), emptyState(), google.drivers);
    expect(google.calls.filter((c) => c.url.includes("functionId=app-foo"))).toHaveLength(3);
  });

  test("a failed build leaves nothing behind", async () => {
    const google = fakeGoogle({ failBuild: "Build failed: missing dependency" });
    await expect(applyConfig(configWith(), emptyState(), google.drivers)).rejects.toThrow(/deploying app-foo failed: Build failed: missing dependency/);
    expect(google.live.size).toBe(0);
    expect(google.accounts.size).toBe(0);
  });

  test("no region fails before any call", async () => {
    const google = fakeGoogle();
    await expect(applyConfig(configWith(), emptyState(), google.build(null))).rejects.toThrow(/Set the router's region option, --region or GOOGLE_CLOUD_REGION/);
    expect(google.calls).toEqual([]);
  });

  test("code, settings and access changes are sent as narrow updates", async () => {
    const google = fakeGoogle();
    const state = emptyState();
    await applyConfig(configWith(), state, google.drivers);
    google.calls.length = 0;
    await applyConfig(configWith({ bundle: { path: "build/foo/index.mjs", sha256: "v2" } }), state, google.drivers);
    const code = google.calls.find((c) => c.method === "PATCH")!;
    expect(code.url).toBe(`${FUNCTIONS}/${NAME}?updateMask=buildConfig.source`);
    expect(code.body.buildConfig.source.storageSource.object).toBe("abc.zip");
    expect(google.uploads).toHaveLength(2);

    google.calls.length = 0;
    await applyConfig(configWith({ bundle: { path: "build/foo/index.mjs", sha256: "v2" }, memory_mb: 512, env: [{ key: "GREETING", value: "yo" }] }), state, google.drivers);
    const config = google.calls.find((c) => c.method === "PATCH")!;
    expect(config.url).toBe(`${FUNCTIONS}/${NAME}?updateMask=serviceConfig.availableMemory,serviceConfig.timeoutSeconds,serviceConfig.environmentVariables`);
    expect(config.body.serviceConfig).toMatchObject({ availableMemory: "512M", environmentVariables: { GREETING: "yo" } });
    expect(google.uploads).toHaveLength(2);

    await applyConfig(configWith({ bundle: { path: "build/foo/index.mjs", sha256: "v2" }, memory_mb: 512, env: [{ key: "GREETING", value: "yo" }], auth: "iam" }, "iam"), state, google.drivers);
    expect(google.live.get(NAME)!.invokers).toEqual([]);
  });

  test("the project and the region cannot change under a deployed function", async () => {
    const google = fakeGoogle();
    const state = emptyState();
    await applyConfig(configWith(), state, google.drivers);
    await expect(applyConfig(configWith({ options: { project: "other-proj-456" }, memory_mb: 512 }), state, google.drivers)).rejects.toThrow(/is in project my-proj-123 and cannot move to other-proj-456/);
    await expect(applyConfig(configWith({ memory_mb: 512 }), state, google.build("europe-west4"))).rejects.toThrow(/is in us-central1 and cannot move to europe-west4/);
  });

  test("delete removes the function and the service account it made, and tolerates both being gone", async () => {
    const google = fakeGoogle();
    const state = emptyState();
    await applyConfig(configWith(), state, google.drivers);
    await applyConfig(empty(), state, google.drivers);
    expect(google.live.size).toBe(0);
    expect(google.accounts.size).toBe(0);
    expect(state.entries).toEqual({});

    const gone = fakeGoogle();
    const second = emptyState();
    await applyConfig(configWith(), second, gone.drivers);
    gone.live.clear();
    gone.accounts.clear();
    await applyConfig(empty(), second, gone.drivers);
    expect(second.entries).toEqual({});
  });

  test("adopt reads only: a function is recorded for the next apply, a missing one is reported, a failed one is an error", async () => {
    const [entry] = plan(configWith(), emptyState()).map((a) => a.desired!);
    const existing = fakeGoogle({ functions: { [NAME]: {} } });
    const adopted = await existing.drivers["@gcp.CloudFunction"]!.adopt!(entry!, { entry: () => undefined });
    expect(adopted!.outputs).toMatchObject({ name: NAME, service_account: SA, service_account_created: "false", url: "https://app-foo-abc-uc.a.run.app" });
    expect(adopted!.spec).toEqual({});
    expect(adopted!.notes![0]).toMatch(/environment variables not in the config are removed/);
    expect(existing.calls.every((c) => c.method === "GET")).toBe(true);
    expect(await fakeGoogle().drivers["@gcp.CloudFunction"]!.adopt!(entry!, { entry: () => undefined })).toBeUndefined();
    await expect(fakeGoogle({ functions: { [NAME]: { state: "FAILED" } } }).drivers["@gcp.CloudFunction"]!.adopt!(entry!, { entry: () => undefined })).rejects.toThrow(/is FAILED: build failed/);
  });
});

describe("http layer", () => {
  test("errors carry the status and message but never the request", () => {
    const err = toApiError({ response: { status: 403, data: { error: { message: "Permission denied" } } }, config: { headers: { authorization: "Bearer secret-token" } }, message: "Request failed" });
    expect(err).toBeInstanceOf(GcpApiError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("Permission denied (HTTP 403)");
    expect(JSON.stringify(err)).not.toContain("secret-token");
    expect(toApiError(new Error("socket hang up")).message).toBe("socket hang up");
  });

  test("requests go through the auth client, and an upload failure is reported", async () => {
    const seen: unknown[] = [];
    const http = httpFor({ request: async (o) => (seen.push(o), { data: { ok: true } }) }, (async () => new Response("", { status: 403 })) as unknown as typeof fetch);
    expect(await http.request("POST", "https://x.example/a", { a: 1 })).toEqual({ ok: true });
    expect(seen).toEqual([{ url: "https://x.example/a", method: "POST", data: { a: 1 } }]);
    await expect(http.upload("https://signed.example", new Uint8Array(), {})).rejects.toThrow(/uploading the function's code failed \(HTTP 403\)/);
  });
});

describe("option validation", () => {
  test("Cloud Function options are checked", () => {
    validateOptions("gcp", "@gcp.CloudFunction", { project: "my-proj-123", max_instances: "10", "env.MODE": "x" }, "f");
    expect(() => validateOptions("gcp", "@gcp.CloudFunction", { project: "Bad" }, "f")).toThrow(/must be a GCP project id/);
    expect(() => validateOptions("gcp", "@gcp.CloudFunction", { max_instances: "0" }, "f")).toThrow(/must be an integer from 1 to 1000/);
    expect(() => validateOptions("gcp", "@gcp.CloudFunction", { tracing: "Active" }, "f")).toThrow(/unknown option "tracing"/);
    expect(() => validateOptions("gcp", "@gcp.CloudFunction", { "env.GOOGLE_X": "1" }, "f")).toThrow(/not a usable environment variable name/);
  });
});
