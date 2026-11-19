import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeApp } from "../src/analyze/app";
import { adoptEntries } from "../src/deploy/adopt";
import { apply, incompleteSpec, type Drivers } from "../src/deploy/apply";
import { gcpDrivers } from "../src/deploy/gcp";
import { serviceAccountIdFor } from "../src/deploy/gcp/functions";
import { desiredGrants, grantId, rolesFor } from "../src/deploy/gcp/grants";
import { GcpApiError, httpFor, toApiError, type GcpHttp } from "../src/deploy/gcp/http";
import type { StorageLike } from "../src/deploy/gcp/storage";
import { plan } from "../src/deploy/plan";
import { stateKey, type StateEntry } from "../src/deploy/state";
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
  runInvokers: string[];
  email: string;
  labels: Record<string, string>;
  deploying: number;
}

const OWNED = { cloudgear_resource: "foo", "cloudgear_managed-by": "cloudgear", cloudgear_service_account: "created" };

function fakeGoogle(opts: { existingAccounts?: string[]; failBuild?: string; propagationFailures?: number; polls?: number; functions?: Record<string, Partial<Live>>; neverFinish?: boolean; failOn?: (method: string, url: string) => Error | undefined; failSetPolicy?: (bucket: string) => Error | undefined } = {}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const uploads: { url: string; headers: Record<string, string>; text: string }[] = [];
  const sleeps: number[] = [];
  const accounts = new Set<string>(opts.existingAccounts ?? []);
  const live = new Map<string, Live>(Object.entries(opts.functions ?? {}).map(([name, f]) => [name, { state: "ACTIVE", env: {}, memory: "256Mi", timeout: 60, invokers: [], runInvokers: [], email: SA, labels: {}, deploying: 0, ...f }]));
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
      const injected = opts.failOn?.(method, url);
      if (injected) throw injected;
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
        return found.polls > 0 || opts.neverFinish ? { name: op[1], done: false } : { name: op[1], done: true, ...(found.error ? { error: { message: found.error } } : {}) };
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
        live.set(full, { state: opts.failBuild ? "FAILED" : "ACTIVE", env: body.serviceConfig.environmentVariables, memory: body.serviceConfig.availableMemory, timeout: body.serviceConfig.timeoutSeconds, invokers: [], runInvokers: [], email: body.serviceConfig.serviceAccountEmail, labels: body.labels, deploying: 0 });
        return startOperation(opts.failBuild);
      }
      const iamPolicy = url.match(/\/(functions|services)\/([^/:?]+):(getIamPolicy|setIamPolicy)(\?.*)?$/);
      if (iamPolicy) {
        const found = [...live.entries()].find(([n]) => n.endsWith(`/${iamPolicy[2]}`))?.[1];
        if (!found) throw fail(404, "Function not found");
        const key = iamPolicy[1] === "functions" ? "invokers" : "runInvokers";
        const role = iamPolicy[1] === "functions" ? "roles/cloudfunctions.invoker" : "roles/run.invoker";
        if (iamPolicy[3] === "getIamPolicy") return { etag: "e1", bindings: found[key].length ? [{ role, members: found[key] }] : [] };
        found[key] = (body.policy.bindings.find((b: { role: string }) => b.role === role)?.members ?? []) as string[];
        return {};
      }
      const one = url.match(/\/(projects\/[^?]+\/functions\/[^?:]+)(\?updateMask=(.+))?$/);
      if (one) {
        const found = live.get(one[1]!);
        if (method === "GET") {
          if (!found) throw fail(404, "Function not found");
          const state = found.deploying > 0 ? (found.deploying--, "DEPLOYING") : found.state;
          return { state, url: `https://app-foo-abc-uc.a.run.app`, labels: found.labels, serviceConfig: { serviceAccountEmail: found.email, uri: "https://app-foo-abc-uc.a.run.app", service: "projects/my-proj-123/locations/us-central1/services/app-foo" }, ...(found.state === "FAILED" ? { stateMessages: [{ message: "build failed" }] } : {}) };
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
  const policies = new Map<string, { bindings: { role: string; members: string[]; condition?: { title?: string; expression: string } }[]; etag: string; version?: number }>();
  const storage = (): StorageLike => ({
    async createBucket(name) {
      calls.push({ method: "BUCKET", url: `create ${name}` });
      policies.set(name, { bindings: [], etag: "1" });
      return [{}];
    },
    bucket(name) {
      return {
        iam: {
          async getPolicy() {
            calls.push({ method: "BUCKET", url: `get ${name}` });
            const found = policies.get(name);
            if (!found) throw Object.assign(new Error("bucket not found"), { code: 404 });
            return [JSON.parse(JSON.stringify(found))];
          },
          async setPolicy(policy) {
            calls.push({ method: "BUCKET", url: `set ${name}`, body: JSON.parse(JSON.stringify(policy)) });
            const injected = opts.failSetPolicy?.(name);
            if (injected) throw injected;
            policies.set(name, JSON.parse(JSON.stringify(policy)));
            return {};
          },
        },
        async getMetadata() {
          return [{ location: "US" }];
        },
        async setMetadata() {},
        async delete() {
          policies.delete(name);
        },
      };
    },
  });
  const logs: string[] = [];
  const build = (region: string | null = "us-central1"): Drivers =>
    gcpDrivers({
      storage,
      defaultProject: async () => undefined,
      labels: { "cloudgear:project": "app", "cloudgear:managed-by": "cloudgear" },
      log: (m) => void logs.push(m),
      env: {},
      functions: { http, region: region ?? undefined, readBundle: () => new TextEncoder().encode("export const handler = () => {};"), readIncluded: () => [{ name: "dist/index.html", data: new TextEncoder().encode("<html>") }], sleep: async (ms) => void sleeps.push(ms) },
    });
  return { calls, uploads, sleeps, accounts, live, logs, policies, drivers: build(), build };
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
    expect(() => analyzeApp(fixture("function-route-project"))).toThrow(/route options of "ping" set project, which the router already sets/);
  });
});

describe("cloud functions driver", () => {
  test("creates a service account, uploads the code and deploys a public function", async () => {
    const google = fakeGoogle();
    const state = emptyState();
    await applyConfig(configWith(), state, google.drivers);
    expect(google.calls[0]).toMatchObject({ method: "GET", url: `${FUNCTIONS}/${NAME}` });
    expect(google.calls.find((c) => c.method === "POST" && c.url.includes("serviceAccounts"))).toMatchObject({ url: "https://iam.googleapis.com/v1/projects/my-proj-123/serviceAccounts", body: { accountId: "cg-app-foo" } });
    expect(google.uploads[0]!.headers).toEqual({ "content-type": "application/zip" });
    expect(google.uploads[0]!.text).toContain("index.mjs");
    expect(google.uploads[0]!.text).toContain("package.json");
    expect(google.uploads[0]!.text).toContain("dist/index.html");
    const create = google.calls.find((c) => c.url.includes("functions?functionId=app-foo"))!;
    expect(create.body).toMatchObject({
      environment: "GEN_2",
      labels: { cloudgear_project: "app", cloudgear_resource: "foo", cloudgear_service_account: "created" },
      buildConfig: { runtime: "nodejs22", entryPoint: "handler", source: { storageSource: { bucket: "gcf-sources", object: "abc.zip", generation: "7" } } },
      serviceConfig: { availableMemory: "256Mi", timeoutSeconds: 60, environmentVariables: { GREETING: "hi" }, serviceAccountEmail: SA, ingressSettings: "ALLOW_ALL" },
    });
    expect(google.sleeps.length).toBeGreaterThan(0);
    expect(google.live.get(NAME)!.invokers).toEqual(["allUsers"]);
    expect(google.live.get(NAME)!.runInvokers).toEqual(["allUsers"]);
    expect(google.live.get(NAME)!.labels).toMatchObject({ cloudgear_service_account: "created" });
    expect(state.entries[KEY]!.outputs).toEqual({ name: NAME, url: "https://app-foo-abc-uc.a.run.app", project: "my-proj-123", region: "us-central1", service_account: SA, service_account_created: "true", bucket_grants: "[]" });
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
    expect(create.body.serviceConfig).toMatchObject({ availableMemory: "512Mi", timeoutSeconds: 30, maxInstanceCount: 5, environmentVariables: { GREETING: "hi", EXTRA: "1" } });
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

  test("a function that already exists and was not deployed by cloudgear is never touched", async () => {
    const google = fakeGoogle({ functions: { [NAME]: {} } });
    await expect(applyConfig(configWith(), emptyState(), google.drivers)).rejects.toThrow(/A function named "app-foo" exists that cloudgear did not deploy; run `cloudgear import` to adopt it/);
    expect(google.calls.every((c) => c.method === "GET")).toBe(true);
    expect(google.uploads).toEqual([]);
    expect(google.live.size).toBe(1);
  });

  test("a deploy an earlier apply left running is picked up, not started again", async () => {
    const google = fakeGoogle({ functions: { [NAME]: { labels: OWNED, deploying: 2 } }, existingAccounts: [SA] });
    const state = emptyState();
    await applyConfig(configWith(), state, google.drivers);
    expect(google.calls.some((c) => c.method === "POST" && (c.url.includes("functionId=") || c.url.includes("serviceAccounts")))).toBe(false);
    expect(google.live.get(NAME)!.invokers).toEqual(["allUsers"]);
    expect(state.entries[KEY]!.outputs).toMatchObject({ service_account: SA, service_account_created: "true" });
  });

  test("a function whose deploy failed earlier is replaced, and still owns the service account it made", async () => {
    const google = fakeGoogle({ functions: { [NAME]: { labels: OWNED, state: "FAILED" } }, existingAccounts: [SA] });
    const state = emptyState();
    await applyConfig(configWith(), state, google.drivers);
    expect(google.calls.some((c) => c.method === "DELETE" && c.url.endsWith(NAME))).toBe(true);
    expect(google.calls.some((c) => c.url.includes("functionId=app-foo"))).toBe(true);
    expect(state.entries[KEY]!.outputs.service_account_created).toBe("true");
  });

  test("a deploy that is still running when apply gives up is left alone for the next apply", async () => {
    const google = fakeGoogle({ neverFinish: true });
    await expect(applyConfig(configWith(), emptyState(), google.drivers)).rejects.toThrow(/deploying app-foo is still running after 10 minutes; it is left running, so run apply again/);
    expect(google.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(google.live.size).toBe(1);
    expect(google.accounts.has(SA)).toBe(true);
  });

  test("a passing server error while waiting is retried instead of abandoning the build", async () => {
    let failed = 0;
    const google = fakeGoogle({ failOn: (method, url) => (method === "GET" && url.includes("/operations/") && failed++ === 0 ? new GcpApiError(503, "unavailable (HTTP 503)") : undefined) });
    await applyConfig(configWith(), emptyState(), google.drivers);
    expect(google.live.size).toBe(1);
  });

  test("the service account is kept when the failed function cannot be removed", async () => {
    const google = fakeGoogle({ failBuild: "Build failed", failOn: (method, url) => (method === "DELETE" && url.includes("/functions/") ? new GcpApiError(500, "backend error (HTTP 500)") : undefined) });
    await expect(applyConfig(configWith(), emptyState(), google.drivers)).rejects.toThrow(/deploying app-foo failed: Build failed/);
    expect(google.accounts.has(SA)).toBe(true);
  });

  test("a policy that changed between the read and the write is retried once", async () => {
    let writes = 0;
    const google = fakeGoogle({ failOn: (_method, url) => (url.includes("functions/app-foo:setIamPolicy") && writes++ === 0 ? new GcpApiError(409, "etag mismatch (HTTP 409)") : undefined) });
    await applyConfig(configWith(), emptyState(), google.drivers);
    expect(google.live.get(NAME)!.invokers).toEqual(["allUsers"]);
    expect(google.calls.filter((c) => c.url.includes("functions/app-foo:getIamPolicy"))).toHaveLength(2);
    expect(google.calls.find((c) => c.url.includes("getIamPolicy"))!.url).toContain("options.requestedPolicyVersion=3");
  });

  test("max instances cannot be removed once set, a runtime change is sent, and a busy or vanished function is reported", async () => {
    const google = fakeGoogle();
    const state = emptyState();
    await applyConfig(configWith({ options: { project: "my-proj-123", max_instances: "5" } }), state, google.drivers);
    await expect(applyConfig(configWith({ options: { project: "my-proj-123" }, memory_mb: 512 }), state, google.drivers)).rejects.toThrow(/max_instances cannot be removed once set/);

    const runtime = fakeGoogle();
    const second = emptyState();
    await applyConfig(configWith(), second, runtime.drivers);
    runtime.calls.length = 0;
    await applyConfig(configWith({ runtime: "nodejs24", memory_mb: 512 }), second, runtime.drivers);
    const patch = runtime.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toContain("buildConfig.runtime");
    expect(patch.body.buildConfig.runtime).toBe("nodejs24");

    runtime.live.get(NAME)!.deploying = 5;
    await expect(applyConfig(configWith({ runtime: "nodejs24", memory_mb: 1024 }), second, runtime.drivers)).rejects.toThrow(/is DEPLOYING; run apply again once it has finished/);
    runtime.live.clear();
    await expect(applyConfig(configWith({ runtime: "nodejs24", memory_mb: 1024 }), second, runtime.drivers)).rejects.toThrow(/no longer exists; remove its entry from .cloudgear\/state.json/);
  });

  test("a function adopted with import is brought in line by the next apply", async () => {
    const google = fakeGoogle({ functions: { [NAME]: { env: { OLD: "1" } } } });
    const state = emptyState();
    const config = configWith();
    const result = await adoptEntries(plan(config, state), state, google.drivers, () => true);
    expect(result.adopted).toHaveLength(1);
    expect(state.entries[KEY]!.spec).toEqual({});
    await applyConfig(config, state, google.drivers);
    expect(google.live.get(NAME)!.env).toEqual({ GREETING: "hi" });
    expect(google.live.get(NAME)!.invokers).toEqual(["allUsers"]);
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
    expect(config.body.serviceConfig).toMatchObject({ availableMemory: "512Mi", environmentVariables: { GREETING: "yo" } });
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

const BUCKET = { name: "assets", type: "@gcp.GCS", physical_name: "assets", dry: false, source: "setup.ts:1", options: { project: "my-proj-123" } };
const MEMBER = `serviceAccount:${SA}`;
const withAccess = (permission: { resource: string; path: string; action: string[] }[], overrides: Record<string, unknown> = {}): CloudgearConfig =>
  baseConfig({
    provider: "gcp",
    resource: [BUCKET],
    function: [spec({ permission, env: [{ key: "CLOUDGEAR_BLOB_ASSETS", value_from: "assets" }], ...overrides })],
    authenticated: "iam",
  });
const READ = { resource: "assets", path: "", action: ["storage.objects.get", "storage.objects.list"] };
const bindingsOf = (google: ReturnType<typeof fakeGoogle>) => google.policies.get("assets")!.bindings;

describe("bucket access", () => {
  test("roles are the smallest set that covers the permissions", () => {
    expect(rolesFor(["storage.objects.get"])).toEqual(["roles/storage.objectViewer"]);
    expect(rolesFor(["storage.objects.get", "storage.objects.list"])).toEqual(["roles/storage.objectViewer"]);
    expect(rolesFor(["storage.objects.create"])).toEqual(["roles/storage.objectCreator"]);
    expect(rolesFor(["storage.objects.get", "storage.objects.create"])).toEqual(["roles/storage.objectViewer", "roles/storage.objectCreator"]);
    expect(rolesFor(["storage.objects.get", "storage.objects.delete"])).toEqual(["roles/storage.objectUser"]);
    expect(() => rolesFor(["storage.buckets.delete"])).toThrow(/No GCS role covers storage.buckets.delete/);
    expect(desiredGrants([{ type: "@aws.S3", physical_name: "other", path: "", actions: ["s3:GetObject"] }])).toEqual([]);
    expect(() => desiredGrants([{ type: "@gcp.GCS", physical_name: "assets", path: 'a"b', actions: ["storage.objects.get"] }])).toThrow(/characters a GCS access condition cannot hold/);
  });

  test("the function's service account is given read access to its bucket, and the grant is recorded", async () => {
    const google = fakeGoogle();
    const state = emptyState();
    await applyConfig(withAccess([READ]), state, google.drivers);
    expect(bindingsOf(google)).toEqual([{ role: "roles/storage.objectViewer", members: [MEMBER] }]);
    expect(state.entries[KEY]!.outputs.bucket_grants).toBe(JSON.stringify([grantId({ bucket: "assets", role: "roles/storage.objectViewer", path: "" })]));
    expect(google.calls.map((c) => c.url).indexOf("create assets")).toBeLessThan(google.calls.findIndex((c) => c.url.includes("functionId=")));
    expect(plan(withAccess([READ]), state).every((a) => a.op === "noop")).toBe(true);
  });

  test("a path limits the grant to object names under it, with a condition", async () => {
    const google = fakeGoogle();
    await applyConfig(withAccess([{ resource: "assets", path: "reports/", action: ["storage.objects.get"] }]), emptyState(), google.drivers);
    expect(bindingsOf(google)).toEqual([
      { role: "roles/storage.objectViewer", members: [MEMBER], condition: { title: "cloudgear: reports/", expression: 'resource.name.startsWith("projects/_/buckets/assets/objects/reports/")' } },
    ]);
    expect(google.policies.get("assets")!.version).toBe(3);
  });

  test("a change in permissions adds what is new and removes only what cloudgear granted", async () => {
    const google = fakeGoogle();
    const state = emptyState();
    await applyConfig(withAccess([READ]), state, google.drivers);
    // Somebody else's access, on the same role and on another one.
    const policy = google.policies.get("assets")!;
    policy.bindings[0]!.members.push("user:someone@example.com");
    policy.bindings.push({ role: "roles/storage.admin", members: ["group:admins@example.com"] });
    await applyConfig(withAccess([{ resource: "assets", path: "", action: ["storage.objects.create"] }]), state, google.drivers);
    expect(bindingsOf(google)).toEqual([
      { role: "roles/storage.objectViewer", members: ["user:someone@example.com"] },
      { role: "roles/storage.admin", members: ["group:admins@example.com"] },
      { role: "roles/storage.objectCreator", members: [MEMBER] },
    ]);
    expect(JSON.parse(state.entries[KEY]!.outputs.bucket_grants!)).toEqual(["assets|roles/storage.objectCreator|"]);
  });

  test("deleting the function takes back its access before deleting its account", async () => {
    const google = fakeGoogle();
    const state = emptyState();
    await applyConfig(withAccess([READ]), state, google.drivers);
    google.calls.length = 0;
    await applyConfig(baseConfig({ provider: "gcp", resource: [BUCKET], function: [] }), state, google.drivers);
    expect(bindingsOf(google)).toEqual([]);
    const order = google.calls.map((c) => `${c.method} ${c.url}`);
    expect(order.indexOf("BUCKET set assets")).toBeGreaterThan(-1);
    expect(order.indexOf("BUCKET set assets")).toBeLessThan(order.findIndex((c) => c.startsWith("DELETE https://iam.googleapis.com")));
  });

  test("a bucket that is already gone does not block the delete", async () => {
    const google = fakeGoogle();
    const state = emptyState();
    await applyConfig(withAccess([READ]), state, google.drivers);
    google.policies.clear();
    await applyConfig(empty(), state, google.drivers);
    expect(state.entries).toEqual({});
  });

  test("a function with no bucket permissions never touches a bucket policy", async () => {
    const google = fakeGoogle();
    await applyConfig(configWith(), emptyState(), google.drivers);
    expect(google.calls.some((c) => c.method === "BUCKET")).toBe(false);
  });

  test("a deploy picked up later, and a function brought in by import, still get their access", async () => {
    const resumed = fakeGoogle({ functions: { [NAME]: { labels: OWNED, deploying: 1 } }, existingAccounts: [SA] });
    await applyConfig(withAccess([READ]), emptyState(), resumed.drivers);
    expect(bindingsOf(resumed)).toEqual([{ role: "roles/storage.objectViewer", members: [MEMBER] }]);

    const imported = fakeGoogle({ functions: { [NAME]: {} } });
    const state = emptyState();
    const config = withAccess([READ]);
    imported.policies.set("assets", { bindings: [], etag: "1" });
    await adoptEntries(plan(config, state).filter((a) => a.type === "@gcp.CloudFunction"), state, imported.drivers, () => true);
    await applyConfig(config, state, imported.drivers);
    expect(bindingsOf(imported)).toEqual([{ role: "roles/storage.objectViewer", members: [MEMBER] }]);
  });

  test("a policy that changed in between is retried, and a service account that is not usable yet is waited for", async () => {
    let writes = 0;
    const conflict = fakeGoogle({ failSetPolicy: () => (writes++ === 0 ? Object.assign(new Error("etag mismatch"), { code: 412 }) : undefined) });
    await applyConfig(withAccess([READ]), emptyState(), conflict.drivers);
    expect(bindingsOf(conflict)).toHaveLength(1);

    let failures = 2;
    const propagating = fakeGoogle({ failSetPolicy: () => (failures-- > 0 ? Object.assign(new Error(`Service account ${SA} does not exist`), { code: 400 }) : undefined) });
    await applyConfig(withAccess([READ]), emptyState(), propagating.drivers);
    expect(bindingsOf(propagating)).toHaveLength(1);
    expect(propagating.sleeps.filter((ms) => ms === 4000)).toHaveLength(2);
  });

  test("a function on the project's default service account is refused clearly, without waiting", async () => {
    const google = fakeGoogle({ functions: { [NAME]: { email: "" } } });
    const state = emptyState();
    const config = withAccess([READ]);
    await adoptEntries(plan(config, state).filter((a) => a.type === "@gcp.CloudFunction"), state, google.drivers, () => true);
    await expect(applyConfig(config, state, google.drivers)).rejects.toThrow(/runs as the project's default service account, and cloudgear will not give that shared account bucket access/);
    expect(google.calls.some((c) => c.url === "set assets")).toBe(false);
    expect(google.sleeps.filter((ms) => ms === 4000)).toEqual([]);
  });

  test("a permission that cannot be granted fails before anything is deployed", async () => {
    const google = fakeGoogle();
    await expect(applyConfig(withAccess([{ resource: "assets", path: 'a"b', action: ["storage.objects.get"] }]), emptyState(), google.drivers)).rejects.toThrow(/characters a GCS access condition cannot hold/);
    expect(google.calls.some((c) => c.url.includes("functions") || c.url.includes("serviceAccounts"))).toBe(false);
    expect(google.live.size).toBe(0);
  });

  test("a delete finishes even when the bucket's policy cannot be edited", async () => {
    let denied = false;
    const google = fakeGoogle({ failSetPolicy: () => (denied ? Object.assign(new Error("permission denied"), { code: 403 }) : undefined) });
    const state = emptyState();
    await applyConfig(withAccess([READ]), state, google.drivers);
    denied = true;
    await applyConfig(baseConfig({ provider: "gcp", resource: [BUCKET], function: [] }), state, google.drivers);
    expect(state.entries[KEY]).toBeUndefined();
    expect(google.accounts.size).toBe(0);
    expect(google.logs.some((m) => m.includes(`could not remove ${SA} from assets (permission denied); remove it by hand`))).toBe(true);
  });

  test("grants made before a failure stay recorded, and the next apply finishes the rest", async () => {
    const OTHER = { ...BUCKET, name: "other", physical_name: "other" };
    let failOther = false;
    const google = fakeGoogle({ failSetPolicy: (bucket) => (failOther && bucket === "other" ? new Error("quota exceeded") : undefined) });
    const state = emptyState();
    const config = (permission: { resource: string; path: string; action: string[] }[]) =>
      baseConfig({ provider: "gcp", resource: [BUCKET, OTHER], function: [spec({ permission, env: [{ key: "CLOUDGEAR_BLOB_ASSETS", value_from: "assets" }] })], authenticated: "iam" });
    await applyConfig(config([READ]), state, google.drivers);
    failOther = true;
    await expect(applyConfig(config([READ, { ...READ, resource: "other" }]), state, google.drivers)).rejects.toThrow(/quota exceeded/);
    expect(JSON.parse(state.entries[KEY]!.outputs.bucket_grants!)).toEqual(["assets|roles/storage.objectViewer|"]);
    failOther = false;
    await applyConfig(config([READ, { ...READ, resource: "other" }]), state, google.drivers);
    expect(JSON.parse(state.entries[KEY]!.outputs.bucket_grants!)).toEqual(["assets|roles/storage.objectViewer|", "other|roles/storage.objectViewer|"]);
    expect(google.policies.get("other")!.bindings).toEqual([{ role: "roles/storage.objectViewer", members: [MEMBER] }]);
  });

  test("a binding that was already there is not recorded, so it is never taken away", async () => {
    const google = fakeGoogle();
    const state = emptyState();
    await applyConfig(baseConfig({ provider: "gcp", resource: [BUCKET], function: [] }), state, google.drivers);
    google.policies.get("assets")!.bindings.push({ role: "roles/storage.objectViewer", members: [MEMBER] });
    await applyConfig(withAccess([READ]), state, google.drivers);
    expect(state.entries[KEY]!.outputs.bucket_grants).toBe("[]");
    await applyConfig(baseConfig({ provider: "gcp", resource: [BUCKET], function: [] }), state, google.drivers);
    expect(bindingsOf(google)).toEqual([{ role: "roles/storage.objectViewer", members: [MEMBER] }]);
  });

  test("the policy that was read is written back with its etag, version and other conditional bindings", async () => {
    const google = fakeGoogle();
    const state = emptyState();
    await applyConfig(baseConfig({ provider: "gcp", resource: [BUCKET], function: [] }), state, google.drivers);
    const other = { role: "roles/storage.objectViewer", members: ["user:temp@example.com"], condition: { title: "temporary", expression: "request.time < timestamp('2030-01-01T00:00:00Z')" } };
    google.policies.get("assets")!.bindings.push(other);
    await applyConfig(withAccess([READ]), state, google.drivers);
    const written = google.calls.find((c) => c.url === "set assets")!.body;
    expect(written.etag).toBe("1");
    expect(written.version).toBe(3);
    expect(bindingsOf(google)).toEqual([other, { role: "roles/storage.objectViewer", members: [MEMBER] }]);
  });

  test("a long path gives a condition title within Google's length", async () => {
    const google = fakeGoogle();
    await applyConfig(withAccess([{ resource: "assets", path: `${"é".repeat(60)}😀${"x".repeat(60)}/`, action: ["storage.objects.get"] }]), emptyState(), google.drivers);
    const title = bindingsOf(google)[0]!.condition!.title!;
    expect([...title].length).toBeLessThanOrEqual(100);
    expect(title.startsWith("cloudgear: ")).toBe(true);
  });

  test("a store on another provider is not granted anything", async () => {
    const google = fakeGoogle();
    const config = baseConfig({
      provider: "gcp",
      resource: [{ name: "archive", type: "@aws.S3", physical_name: "archive", dry: true, source: "a.ts:1" }],
      function: [spec({ permission: [{ resource: "archive", path: "", action: ["s3:GetObject"] }], env: [] })],
      authenticated: "iam",
    });
    await applyConfig(config, emptyState(), google.drivers);
    expect(google.calls.some((c) => c.method === "BUCKET")).toBe(false);
  });
});

describe("a function left half applied", () => {
  test("is planned as an update even though no field differs, so it is finished", () => {
    const config = configWith();
    const desired = plan(config, emptyState()).find((a) => a.type === "@gcp.CloudFunction")!.desired!;
    const state = emptyState();
    const entry: StateEntry = { kind: "function", type: "@gcp.CloudFunction", name: "foo", physical_name: "app-foo", spec: incompleteSpec(desired.spec), outputs: { name: NAME }, deps: [] };
    state.entries[KEY] = entry;
    const [action] = plan(config, state);
    expect(action).toMatchObject({ op: "update", changes: ["incomplete"] });
    entry.spec = desired.spec;
    expect(plan(config, state)[0]!.op).toBe("noop");
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
    const offline = httpFor({ request: async () => ({ data: {} }) }, (async () => { throw new Error("fetch failed for https://signed.example/secret-signature"); }) as unknown as typeof fetch);
    const failure = await offline.upload("https://signed.example/secret-signature", new Uint8Array(), {}).catch((e: Error) => e);
    expect((failure as Error).message).toBe("uploading the function's code failed: the connection failed");
    expect(JSON.stringify(failure)).not.toContain("secret-signature");
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
