import { describe, expect, test } from "bun:test";
import { MemoryDnsDriver } from "@cloudgear/dns/drivers/memory";
import type { CloudgearConfig } from "../src/config/schema";
import { apply, type Drivers } from "../src/deploy/apply";
import { gcpDrivers } from "../src/deploy/gcp";
import type { StorageLike } from "../src/deploy/gcp/storage";
import { plan } from "../src/deploy/plan";
import { baseConfig, emptyState } from "./helpers";

const DOMAIN = "cdn.example.com";
const CERT_KEY = `@gcp.Certificate.${DOMAIN}`;
const CDN_KEY = `@gcp.CloudCdn.${DOMAIN}`;
const dnsSpec = { provider: "gandi", domain: DOMAIN, zone: "example.com" };

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Options {
  certificateStates?: string[];
  fail?: (method: string, url: string) => Error | undefined;
  policies?: Record<string, { bindings: { role: string; members: string[] }[] }>;
}

function fakeGcp(options: Options = {}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  const compute = new Map<string, any>();
  const manager = new Map<string, any>();
  const policies = new Map<string, { bindings: { role: string; members: string[] }[] }>(Object.entries(options.policies ?? {}));
  const buckets = new Set<string>();
  const states = [...(options.certificateStates ?? ["PROVISIONING", "ACTIVE"])];
  const dns = new MemoryDnsDriver();
  const sleeps: number[] = [];
  const logs: string[] = [];

  const http = {
    async request(method: string, url: string, body?: any) {
      calls.push({ method, url, body });
      const injected = options.fail?.(method, url);
      if (injected) throw injected;
      const [path, query] = url.split("?");
      if (path!.startsWith("https://certificatemanager.googleapis.com/v1/")) {
        const key = path!.slice("https://certificatemanager.googleapis.com/v1/".length);
        if (method === "POST") {
          const id = new URLSearchParams(query).get([...new URLSearchParams(query).keys()][0]!)!;
          const full = `${key}/${id}`;
          if (manager.has(full)) throw new ApiError(409, "already exists");
          manager.set(full, { ...body, name: full });
          return { name: "operations/op", done: true };
        }
        if (method === "DELETE") {
          if (!manager.has(key)) throw new ApiError(404, "not found");
          manager.delete(key);
          return { name: "operations/op", done: true };
        }
        const found = manager.get(key);
        if (!found) throw new ApiError(404, "not found");
        if (key.includes("/dnsAuthorizations/")) return { ...found, dnsResourceRecord: { name: "_acme-challenge_abc.example.com.", type: "CNAME", data: "abc.authorize.certificatemanager.goog." } };
        if (key.includes("/certificates/")) return { ...found, managed: { ...found.managed, state: states.length > 1 ? states.shift() : states[0] } };
        return found;
      }
      const match = /\/projects\/([^/]+)\/global\/([^/]+)(?:\/([^/]+))?(?:\/wait)?$/.exec(path!)!;
      const [, , collection, name] = match;
      if (collection === "operations") return { status: "DONE" };
      const key = `${collection}/${name ?? body?.name}`;
      if (method === "POST") {
        if (compute.has(key)) throw new ApiError(409, "already exists");
        compute.set(key, { ...body, ...(collection === "addresses" ? { address: "34.0.0.1" } : {}) });
        return { name: "op", status: "DONE" };
      }
      if (method === "PATCH") {
        compute.set(key, { ...compute.get(key), ...body });
        return { name: "op", status: "DONE" };
      }
      if (method === "DELETE") {
        if (!compute.has(key)) throw new ApiError(404, "not found");
        compute.delete(key);
        return { name: "op", status: "DONE" };
      }
      return compute.get(key);
    },
    async upload() {},
  };

  const storage = (): StorageLike =>
    ({
      async createBucket(name: string) {
        buckets.add(name);
        return [{}];
      },
      bucket(name: string) {
        return {
          file: () => ({ save: async () => {}, delete: async () => {} }),
          iam: {
            getPolicy: async () => [{ bindings: (policies.get(name)?.bindings ?? []).map((b) => ({ ...b, members: [...b.members] })) }],
            setPolicy: async (policy: { bindings: { role: string; members: string[] }[] }) => void policies.set(name, policy),
          },
          getMetadata: async () => [{ location: "US" }],
          setMetadata: async () => {},
          delete: async () => void buckets.delete(name),
        };
      },
    }) as unknown as StorageLike;

  const drivers = gcpDrivers({
    storage,
    defaultProject: async () => "adc-project",
    log: (m) => void logs.push(m),
    env: {},
    edge: { http: http as never, dns: async () => dns, sleep: async (ms) => void sleeps.push(ms) },
  });
  return { calls, compute, manager, policies, dns, drivers, sleeps, logs, buckets };
}

const config = (overrides: Partial<CloudgearConfig> = {}, bucketOptions: Record<string, string> = { project: "my-proj", public_read: "true" }): CloudgearConfig => ({
  ...baseConfig({ provider: "gcp", function: [] }),
  resource: [{ name: "site", type: "@gcp.GCS", physical_name: "site", dry: false, source: "setup.ts:1", options: bucketOptions }],
  certificate: [{ provider: "gcp", domain: DOMAIN, dns: dnsSpec, usage: "cdn" }],
  cdn: [{ provider: "gcp", domain: DOMAIN, bucket: "site", path: "" }],
  ...overrides,
});

const run = (cfg: CloudgearConfig, state: ReturnType<typeof emptyState>, drivers: Drivers) => apply(plan(cfg, state), state, drivers, { save: () => {}, log: () => {} });

describe("gcp certificate", () => {
  test("authorizes the domain, writes the record, and waits until the certificate is active", async () => {
    const gcp = fakeGcp();
    const state = emptyState();
    await run(config(), state, gcp.drivers);
    const outputs = state.entries[CERT_KEY]!.outputs;
    expect(outputs.certificate).toMatch(/^projects\/my-proj\/locations\/global\/certificates\/cg-cdn-example-com$/);
    expect(outputs.validation_name).toBe("_acme-challenge_abc.example.com");
    expect(await gcp.dns.get("_acme-challenge_abc.example.com", "CNAME")).toMatchObject({ values: ["abc.authorize.certificatemanager.goog."] });
    const created = gcp.calls.find((c) => c.method === "POST" && c.url.includes("/certificates?"))!;
    expect(created.body).toEqual({ managed: { domains: [DOMAIN], dnsAuthorizations: [outputs.dns_authorization] } });
    expect(gcp.sleeps.length).toBeGreaterThan(0);
  });

  test("a wildcard certificate authorizes the parent domain", async () => {
    const gcp = fakeGcp();
    const state = emptyState();
    const cfg = config({ certificate: [{ provider: "gcp", domain: "*.example.com", dns: { ...dnsSpec, domain: "*.example.com" }, usage: "cdn" }], cdn: [] });
    await run(cfg, state, gcp.drivers);
    expect(gcp.calls.find((c) => c.url.includes("dnsAuthorizations?"))!.body).toEqual({ domain: "example.com" });
    expect(gcp.calls.find((c) => c.url.includes("/certificates?"))!.url).toContain("certificateId=cg-wildcard-example-com");
  });

  test("a failed certificate keeps its progress and the next apply resumes", async () => {
    const gcp = fakeGcp({ certificateStates: ["FAILED"] });
    const state = emptyState();
    await expect(run(config(), state, gcp.drivers)).rejects.toThrow(/failed/);
    expect(state.entries[CERT_KEY]!.outputs.certificate).toBeTruthy();
    const before = gcp.calls.filter((c) => c.method === "POST").length;
    await expect(run(config(), state, gcp.drivers)).rejects.toThrow(/failed/);
    expect(gcp.calls.filter((c) => c.method === "POST" && c.url.includes("dnsAuthorizations")).length).toBe(1);
    expect(gcp.calls.filter((c) => c.method === "POST").length).toBe(before);
  });

  test("an authorization record with another value is an error", async () => {
    const gcp = fakeGcp();
    await gcp.dns.upsert({ name: "_acme-challenge_abc.example.com", type: "CNAME", values: ["other."], ttl: 300 });
    await expect(run(config(), emptyState(), gcp.drivers)).rejects.toThrow(/already exists with a different value/);
  });

  test("an existing record on the domain stops the first create", async () => {
    const gcp = fakeGcp();
    await gcp.dns.upsert({ name: DOMAIN, type: "A", values: ["1.2.3.4"], ttl: 300 });
    await expect(run(config(), emptyState(), gcp.drivers)).rejects.toThrow(/DNS record cdn.example.com already exists \(A 1.2.3.4\)/);
    expect(gcp.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("gcp CDN", () => {
  test("creates the chain in order and points the name at the address", async () => {
    const gcp = fakeGcp();
    const state = emptyState();
    await run(config(), state, gcp.drivers);
    const outputs = state.entries[CDN_KEY]!.outputs;
    expect(outputs).toMatchObject({ address: "34.0.0.1", project: "my-proj", public_binding: "added", public_bucket: "site", a_record: DOMAIN, url: `https://${DOMAIN}` });
    expect([...gcp.compute.keys()]).toEqual([
      "addresses/cg-cdn-example-com-ip",
      "backendBuckets/cg-cdn-example-com-bucket",
      "urlMaps/cg-cdn-example-com-map",
      "targetHttpsProxies/cg-cdn-example-com-https",
      "forwardingRules/cg-cdn-example-com-https-rule",
      "urlMaps/cg-cdn-example-com-redirect",
      "targetHttpProxies/cg-cdn-example-com-http",
      "forwardingRules/cg-cdn-example-com-http-rule",
    ]);
    expect(gcp.compute.get("backendBuckets/cg-cdn-example-com-bucket")).toMatchObject({ bucketName: "site", enableCdn: true });
    expect(gcp.compute.get("forwardingRules/cg-cdn-example-com-https-rule")).toMatchObject({ IPAddress: "34.0.0.1", portRange: "443", loadBalancingScheme: "EXTERNAL_MANAGED" });
    expect(gcp.compute.get("targetHttpsProxies/cg-cdn-example-com-https")!.certificateMap).toBe("//certificatemanager.googleapis.com/projects/my-proj/locations/global/certificateMaps/cg-cdn-example-com-certs");
    expect(gcp.compute.get("urlMaps/cg-cdn-example-com-redirect")!.defaultUrlRedirect).toMatchObject({ httpsRedirect: true });
    expect(await gcp.dns.get(DOMAIN, "A")).toMatchObject({ values: ["34.0.0.1"] });
    expect(gcp.policies.get("site")!.bindings).toEqual([{ role: "roles/storage.legacyObjectReader", members: ["allUsers"] }]);
    expect(plan(config(), state).every((a) => a.op === "noop")).toBe(true);
  });

  test("a bucket that was already public keeps its binding when the CDN is destroyed", async () => {
    const gcp = fakeGcp({ policies: { site: { bindings: [{ role: "roles/storage.legacyObjectReader", members: ["allUsers"] }] } } });
    const state = emptyState();
    await run(config(), state, gcp.drivers);
    expect(state.entries[CDN_KEY]!.outputs.public_binding).toBe("existing");
    await run({ ...config(), cdn: [], certificate: [] }, state, gcp.drivers);
    expect(gcp.policies.get("site")!.bindings).toHaveLength(1);
  });

  test("destroy removes everything cloudgear made, the binding it added and the record it wrote", async () => {
    const gcp = fakeGcp();
    const state = emptyState();
    await run(config(), state, gcp.drivers);
    await run({ ...config(), cdn: [], certificate: [] }, state, gcp.drivers);
    expect(gcp.compute.size).toBe(0);
    expect([...gcp.manager.keys()]).toEqual([]);
    expect(gcp.policies.get("site")!.bindings).toEqual([]);
    expect(await gcp.dns.get(DOMAIN, "A")).toBeNull();
  });

  test("destroy leaves an A record that no longer points at the address", async () => {
    const gcp = fakeGcp();
    const state = emptyState();
    await run(config(), state, gcp.drivers);
    await gcp.dns.upsert({ name: DOMAIN, type: "A", values: ["9.9.9.9"], ttl: 300 });
    await run({ ...config(), cdn: [], certificate: [] }, state, gcp.drivers);
    expect(await gcp.dns.get(DOMAIN, "A")).toMatchObject({ values: ["9.9.9.9"] });
  });

  test("an existing CNAME on the name is an error", async () => {
    const gcp = fakeGcp();
    await gcp.dns.upsert({ name: DOMAIN, type: "CNAME", values: ["other.example.net"], ttl: 300 });
    await expect(run(config(), emptyState(), gcp.drivers)).rejects.toThrow(/already exists \(CNAME other.example.net\)/);
  });

  test("a failure after the forwarding rule records the progress and the next apply finishes", async () => {
    let failing = true;
    const gcp = fakeGcp({ fail: (method, url) => (failing && method === "POST" && url.includes("/targetHttpProxies") ? new ApiError(500, "boom") : undefined) });
    const state = emptyState();
    await expect(run(config(), state, gcp.drivers)).rejects.toThrow(/boom/);
    expect(state.entries[CDN_KEY]!.outputs).toMatchObject({ https_rule: "cg-cdn-example-com-https-rule", redirect_map: "cg-cdn-example-com-redirect" });
    expect(state.entries[CDN_KEY]!.outputs.http_proxy).toBeUndefined();
    failing = false;
    await run(config(), state, gcp.drivers);
    expect(state.entries[CDN_KEY]!.outputs.a_record).toBe(DOMAIN);
    expect(gcp.compute.size).toBe(8);
  });

  test("a refused public binding names the organization policies", async () => {
    const refused = fakeGcp();
    const storageFail = gcpDrivers({
      storage: () => ({ bucket: () => ({ iam: { getPolicy: async () => [{ bindings: [] }], setPolicy: async () => Promise.reject(Object.assign(new Error("not allowed"), { code: 403 })) }, getMetadata: async () => [{ location: "US" }], setMetadata: async () => {}, delete: async () => {}, file: () => ({}) }), createBucket: async () => [{}] }) as never,
      defaultProject: async () => "p",
      log: () => {},
      env: {},
      edge: { http: { request: async (_method: string, url: string) => (url.includes("certificatemanager") ? { done: true, managed: { state: "ACTIVE" }, dnsResourceRecord: { name: "_a.example.com.", data: "x." } } : { status: "DONE", address: "34.0.0.1" }) } as never, dns: async () => refused.dns, sleep: async () => {} },
    });
    await expect(run(config(), emptyState(), storageFail)).rejects.toThrow(/publicAccessPrevention.*allowedPolicyMemberDomains/);
  });

  test("a changed bucket repoints the backend bucket and moves the binding", async () => {
    const gcp = fakeGcp();
    const state = emptyState();
    await run(config(), state, gcp.drivers);
    const other = config({ resource: [...config().resource, { name: "other", type: "@gcp.GCS", physical_name: "other", dry: false, source: "setup.ts:2", options: { project: "my-proj", public_read: "true" } }], cdn: [{ provider: "gcp", domain: DOMAIN, bucket: "other", path: "" }] });
    await run(other, state, gcp.drivers);
    expect(gcp.compute.get("backendBuckets/cg-cdn-example-com-bucket")!.bucketName).toBe("other");
    expect(gcp.policies.get("site")!.bindings).toEqual([]);
    expect(gcp.policies.get("other")!.bindings).toEqual([{ role: "roles/storage.legacyObjectReader", members: ["allUsers"] }]);
  });

  test("project from the bucket option is used; without it the credentials' project is", async () => {
    const gcp = fakeGcp();
    await run(config({}, { public_read: "true" }), emptyState(), gcp.drivers);
    expect(gcp.calls.find((c) => c.url.includes("/projects/"))!.url).toContain("/projects/adc-project/");
  });
});

describe("around the gcp CDN", () => {
  test("invalidate posts one call per path with the host", async () => {
    const gcp = fakeGcp();
    const state = emptyState();
    await run(config(), state, gcp.drivers);
    const { invalidateGcpCdn } = await import("../src/deploy/gcp/cdn");
    const http = { request: async (method: string, url: string, body?: any) => (gcp.calls.push({ method, url, body }), { name: "op", status: "DONE" }) } as never;
    await invalidateGcpCdn({ http, sleep: async () => {} }, "my-proj", "cg-cdn-example-com-map", DOMAIN, ["/*", "/a.png"]);
    const posts = gcp.calls.filter((c) => c.url.endsWith("/invalidateCache"));
    expect(posts.map((c) => c.body)).toEqual([{ host: DOMAIN, path: "/*" }, { host: DOMAIN, path: "/a.png" }]);
  });

  test("a deployed gcp CDN is chosen for invalidation", async () => {
    const gcp = fakeGcp();
    const state = emptyState();
    await run(config(), state, gcp.drivers);
    const { siteDistributions, pickDistribution } = await import("../src/cdnselect");
    expect(pickDistribution(siteDistributions(config(), state), undefined).type).toBe("@gcp.CloudCdn");
  });

  test("the DNS check covers a gcp CDN's name", async () => {
    const { checkDns } = await import("../src/dnscheck");
    const lookup = { records: async (host: string) => (host === DOMAIN ? ["1.2.3.4"] : []), nameservers: async () => ["ns1.example.com"] };
    const check = await checkDns(plan(config(), emptyState()), lookup);
    expect(check.problems.join("\n")).toContain(`${DOMAIN} already resolves to 1.2.3.4`);
  });

  test("status describes the forwarding rule and the certificate", async () => {
    const { GcpCdnDriver, GcpCertDriver } = await import("../packages/cdn/drivers/gcp-cdn");
    const seen: string[] = [];
    const auth = {
      getProjectId: async () => "p",
      request: async ({ url }: { url: string }) => {
        seen.push(url);
        if (url.includes("forwardingRules/cg-cdn-example-com-https-rule")) return { data: { name: "cg-cdn-example-com-https-rule" } };
        if (url.includes("/certificates/cg-cdn-example-com")) return { data: { name: "projects/p/locations/global/certificates/cg-cdn-example-com", managed: { state: "PROVISIONING" } } };
        throw Object.assign(new Error("not found"), { response: { status: 404 } });
      },
    };
    expect(await new GcpCdnDriver(auth).describe(DOMAIN)).toMatchObject({ state: "deployed", url: `https://${DOMAIN}` });
    expect(await new GcpCdnDriver(auth).describe("other.example.com")).toEqual({ state: "none" });
    expect(await new GcpCertDriver(auth).describe(DOMAIN)).toMatchObject({ state: "pending" });
    expect(await new GcpCertDriver(auth).describe("other.example.com")).toEqual({ state: "none" });
  });
});
