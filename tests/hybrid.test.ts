import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHandler, type GcpRequest } from "@cloudgear/functions/drivers/gcp";
import { decodeConfig } from "../src/config/schema";
import { formatPlan, plan } from "../src/deploy/plan";
import { generate } from "../src/generate";
import { capability, crossProviderAccess, providerOfType, validateOptions } from "../src/providers";
import { emptyState } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "hybrid", name);
const generated = async (file: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-"));
  const configPath = path.join(dir, "cloudgear.prototxt");
  const result = await generate({ entry: file, configPath, buildDir: path.join(dir, "build"), project: "hybrid" });
  return { ...result, dir, configPath, text: fs.readFileSync(configPath, "utf8") };
};

describe("provider of a resource type", () => {
  test("is the name after the @", () => {
    expect(providerOfType("@aws.S3")).toBe("aws");
    expect(providerOfType("@gcp.CloudFunction")).toBe("gcp");
    expect(() => providerOfType("S3")).toThrow(/does not name a provider/);
  });

  test("a provider without a CDN, an API domain or schedules says so", () => {
    expect(capability("aws", "cdn").type).toBe("@aws.CloudFront");
    expect(() => capability("gcp", "cdn")).toThrow(/Provider "gcp" does not support a CDN yet/);
    expect(() => capability("gcp", "api")).toThrow(/an API domain/);
    expect(() => capability("gcp", "schedule")).toThrow(/schedules/);
  });

  test("options and reserved environment names follow the resource's provider", () => {
    expect(() => validateOptions("gcp", "@gcp.GCS", { versioning: "true" }, "x")).not.toThrow();
    expect(() => validateOptions("gcp", "@gcp.GCS", { tracing: "Active" }, "x")).toThrow(/unknown option "tracing" for @gcp.GCS \(supported: versioning\)/);
    expect(() => validateOptions("gcp", "@gcp.CloudFunction", { "env.K_SERVICE": "x" }, "x")).toThrow(/not a usable environment variable name/);
    expect(() => validateOptions("gcp", "@gcp.CloudFunction", { "env.AWS_REGION": "x" }, "x")).not.toThrow();
    expect(() => validateOptions("aws", "@aws.Lambda", { "env.AWS_REGION": "x" }, "x")).toThrow(/not a usable environment variable name/);
  });

  test("no cross-provider access mechanism exists yet", () => {
    expect(crossProviderAccess("gcp", "aws")).toBeUndefined();
  });
});

describe("a GCP function with an AWS bucket and a GCS bucket", () => {
  test("each entry takes its type, runtime and permissions from its own provider", async () => {
    const { config, text } = await generated(fixture("gcp-function-aws-store.ts"));
    expect(config.provider).toBe("gcp");
    expect(config.resource.map((r) => [r.name, r.type])).toEqual([["archive", "@aws.S3"], ["cache", "@gcp.GCS"]]);
    expect(config.function.map((f) => [f.name, f.type, f.runtime, f.timeout_s])).toEqual([
      ["getReport", "@gcp.CloudFunction", "nodejs22", 60],
      ["warm", "@gcp.CloudFunction", "nodejs22", 60],
    ]);
    const permissions = Object.fromEntries(config.function.map((f) => [f.name, f.permission.map((p) => [p.resource, p.action])]));
    expect(permissions).toEqual({
      getReport: [["archive", ["s3:GetObject", "s3:ListBucket"]], ["cache", ["storage.objects.get"]]],
      warm: [["cache", ["storage.objects.create"]]],
    });
    expect(text).toContain('type: "@aws.S3"');
    expect(text).toContain('type: "@gcp.GCS"');
    expect(text).toContain('type: "@gcp.CloudFunction"');
    expect(decodeConfig(text)).toEqual(config);
  });

  test("using a store of another provider warns that nothing grants the access yet", async () => {
    const { warnings } = await generated(fixture("gcp-function-aws-store.ts"));
    expect(warnings).toEqual([
      expect.stringMatching(/"getReport" \(gcp\) uses BlobStore "archive" \(aws\); cross-provider access is not provisioned yet, so the function gets no credentials for it/),
    ]);
    expect((await generated(fixture("gcp-only.ts"))).warnings).toEqual([]);
  });

  test("options are validated against each resource's own provider", async () => {
    const { config } = await generated(fixture("gcp-function-aws-store.ts"));
    expect(config.resource.map((r) => r.options)).toEqual([{ versioning: "true" }, { versioning: "true" }]);
  });

  test("the functions are bundled with the GCP adapter", async () => {
    const { dir } = await generated(fixture("gcp-only.ts"));
    const entry = fs.readFileSync(path.join(dir, "build", "get", "entry.ts"), "utf8");
    expect(entry).toContain("drivers/gcp");
    expect(fs.existsSync(path.join(dir, "build", "get", "index.mjs"))).toBe(true);
  });

  test("plan lists both providers' resources", async () => {
    const { config } = await generated(fixture("gcp-function-aws-store.ts"));
    const text = formatPlan(plan(config, emptyState()));
    expect(text).toContain("+ @aws.S3 archive");
    expect(text).toContain("+ @gcp.GCS cache");
    expect(text).toContain("+ @gcp.CloudFunction getReport");
  });

  test("apply stops before doing anything when a provider has no deployers", async () => {
    const { dir, configPath } = await generated(fixture("gcp-function-aws-store.ts"));
    const proc = Bun.spawnSync(["bun", path.join(import.meta.dir, "..", "src", "cli.ts"), "apply", "--auto-approve", "--config", configPath], {
      cwd: dir,
      env: { ...process.env, AWS_REGION: "eu-west-1" },
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toMatch(/Provider "gcp" has no deploy drivers yet; the config can be planned but not applied/);
    expect(fs.existsSync(path.join(dir, ".cloudgear", "state.json"))).toBe(false);
  });

  test("a schedule on a provider without schedules is refused at plan", async () => {
    const { config } = await generated(fixture("gcp-only.ts"));
    config.function[0]!.schedule = ["0 3 * * *"];
    expect(() => plan(config, emptyState())).toThrow(/Provider "gcp" does not support schedules yet/);
  });
});

describe("the GCP function adapter", () => {
  const response = () => {
    const sent: { status?: number; headers: Record<string, string>; body?: string } = { headers: {} };
    return {
      sent,
      res: {
        status: (code: number) => void (sent.status = code),
        set: (name: string, value: string) => void (sent.headers[name] = value),
        send: (body: string) => void (sent.body = body),
      },
    };
  };
  const request = (overrides: Partial<GcpRequest> = {}): GcpRequest => ({ method: "GET", url: "/items/7?x=1", headers: {}, ...overrides });

  test("routes by path, passes path and query input, and writes status, headers and body", async () => {
    const handler = createHandler(async (input: unknown) => ({ input }), [{ method: "GET", path: "/items/{id}" }]);
    const { sent, res } = response();
    await handler(request(), res);
    expect(sent.status).toBe(200);
    expect(sent.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(sent.body!)).toEqual({ input: { id: "7", x: "1" } });
  });

  test("reads a JSON body from rawBody, a string body or a parsed body", async () => {
    const handler = createHandler(async (input: unknown) => input, [{ method: "POST", path: "/echo" }]);
    for (const overrides of [
      { rawBody: new TextEncoder().encode('{"a":1}') },
      { body: '{"a":1}' },
      { body: { a: 1 } },
    ]) {
      const { sent, res } = response();
      await handler(request({ method: "POST", url: "/echo", headers: { "content-type": "application/json" }, ...overrides }), res);
      expect(JSON.parse(sent.body!)).toEqual({ a: 1 });
    }
  });

  test("an unknown route is 404, and repeated headers are joined", async () => {
    const seen: (string | null)[] = [];
    const handler = createHandler(async () => ({ ok: true }), [{ method: "GET", path: "/x" }], {
      authenticate: async (req) => (seen.push(req.headers.get("x-t")), { subject: "u", claims: {} }),
    });
    const missing = response();
    await handler(request({ url: "/nope" }), missing.res);
    expect(missing.sent.status).toBe(404);
    const found = response();
    await handler(request({ url: "/x", headers: { "x-t": ["a", "b"] } }), found.res);
    expect(found.sent.status).toBe(200);
    expect(seen).toEqual([null, "a, b"]);
  });

  test("token verification still applies", async () => {
    const handler = createHandler(async () => ({ ok: true }), [{ method: "GET", path: "/x" }], { authenticate: async () => null });
    const { sent, res } = response();
    await handler(request({ url: "/x" }), res);
    expect(sent.status).toBe(401);
  });
});
