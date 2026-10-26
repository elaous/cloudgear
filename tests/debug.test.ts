import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BlobStore } from "@cloudgear/blob";
import { debug, errorSummary, isDebug, redact, setDebugSink, timed } from "@cloudgear/debug";
import { GandiDnsDriver } from "@cloudgear/dns/drivers/gandi";
import { FunctionRouter } from "@cloudgear/functions";
import { createHandler } from "@cloudgear/functions/drivers/aws";
import { applyAll, baseConfig, emptyState, fakeAws } from "./helpers";

setDefaultTimeout(30_000);

const lines: string[] = [];
const enable = () => {
  process.env.CG_DEBUG = "true";
  lines.length = 0;
  setDebugSink((line) => void lines.push(line));
};
afterEach(() => {
  delete process.env.CG_DEBUG;
  setDebugSink();
});

describe("CG_DEBUG", () => {
  test("is on for true, 1, yes and on, in any case, and off otherwise", () => {
    for (const value of ["true", "TRUE", "1", "yes", "on"]) {
      process.env.CG_DEBUG = value;
      expect(isDebug()).toBe(true);
    }
    for (const value of ["", "false", "0", "no", "off", "truthy"]) {
      process.env.CG_DEBUG = value;
      expect(isDebug()).toBe(false);
    }
    delete process.env.CG_DEBUG;
    expect(isDebug()).toBe(false);
  });

  test("debug() writes one tagged line with the scope, message and data, and nothing when off", () => {
    lines.length = 0;
    setDebugSink((line) => void lines.push(line));
    debug("scope", "silent", { a: 1 });
    expect(lines).toEqual([]);
    enable();
    debug("scope", "hello", { a: 1, b: "x" });
    debug("scope", "bare");
    expect(lines[0]).toMatch(/^\[cg:debug \d\d:\d\d:\d\d\.\d{3}\] scope: hello \{"a":1,"b":"x"\}$/);
    expect(lines[1]).toMatch(/\] scope: bare$/);
  });

  test("timed() reports success and failure with a duration, and is invisible when off", async () => {
    let ran = 0;
    lines.length = 0;
    setDebugSink((line) => void lines.push(line));
    expect(await timed("t", "quiet", async () => ++ran, () => Promise.reject(new Error("data is built only when debugging")) as never)).toBe(1);
    await expect(timed("t", "quiet", async () => Promise.reject(new Error("still thrown")))).rejects.toThrow("still thrown");
    expect(ran).toBe(1);
    expect(lines).toEqual([]);

    enable();
    expect(await timed("t", "work", async () => "done", { k: 1 })).toBe("done");
    await expect(timed("t", "boom", async () => Promise.reject(Object.assign(new Error("bad"), { name: "OopsError" })))).rejects.toThrow("bad");
    expect(lines[0]).toMatch(/t: work ok \(\d+ms\) \{"k":1\}/);
    expect(lines[1]).toMatch(/t: boom failed \(\d+ms\): OopsError: bad/);
    lines.length = 0;
    await timed("t", "lazy", async () => 1, () => ({ computed: true }));
    expect(lines[0]).toMatch(/t: lazy ok \(\d+ms\) \{"computed":true\}/);
  });
});

describe("redact", () => {
  test("hides secrets, payloads and identities by key name", () => {
    const value = redact({
      Authorization: "Bearer abc",
      token: "t",
      Environment: { Variables: { DB_PASSWORD: "p" } },
      Code: { ZipFile: new Uint8Array(10) },
      PolicyDocument: "{}",
      secretAccessKey: "s",
      claims: { sub: "u" },
      Key: "photos/a.png",
      Bucket: "b",
    }) as Record<string, any>;
    expect(value.Authorization).toBe("[redacted]");
    expect(value.token).toBe("[redacted]");
    expect(value.Environment).toBe("[redacted]");
    expect(value.Code.ZipFile).toBe("[redacted]");
    expect(value.PolicyDocument).toBe("[redacted]");
    expect(value.secretAccessKey).toBe("[redacted]");
    expect(value.claims).toBe("[redacted]");
    expect(value.Key).toBe("photos/a.png");
    expect(value.Bucket).toBe("b");
  });

  test("also hides signatures, sessions, JWTs, passwords, payloads and generic values", () => {
    const value = redact({
      Targets: [{ Id: "1", Input: "{\"apiKey\":\"x\"}" }],
      Headers: [{ Name: "x", Value: "v" }],
      SSECustomerKey: "k",
      signature: "s",
      sessionToken: "t",
      jwt: "j",
      passwd: "p",
      pwd: "p",
      Payload: "p",
      DomainName: "api.example.com",
    }) as Record<string, any>;
    expect(value.Targets[0].Input).toBe("[redacted]");
    expect(value.Headers).toBe("[redacted]");
    for (const key of ["SSECustomerKey", "signature", "sessionToken", "jwt", "passwd", "pwd", "Payload"]) expect(value[key]).toBe("[redacted]");
    expect(value.Targets[0].Id).toBe("1");
    expect(value.DomainName).toBe("api.example.com");
  });

  test("error summaries never quote what a parser failed on", () => {
    let parseError: unknown;
    try {
      JSON.parse("secret-password-here");
    } catch (err) {
      parseError = err;
    }
    expect(errorSummary(parseError)).toBe("SyntaxError: invalid input");
    expect(errorSummary(Object.assign(new Error("x".repeat(500)), { name: "Other" }))).toBe(`Other: ${"x".repeat(300)}`);
  });

  test("shortens long strings, arrays and deep objects, and sizes bytes", () => {
    expect(redact("x".repeat(500))).toMatch(/^x{160}…\(500 chars\)$/);
    expect(redact(Array.from({ length: 25 }, (_, i) => i))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, "…15 more"]);
    expect(redact({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: { c: "[object]" } } });
    expect(redact(new Uint8Array(3), "data")).toBe("[3 bytes]");
    expect(redact(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
    expect(redact([[[["x"]]]])).toEqual([[["[1 items]"]]]);
  });
});

describe("what is logged", () => {
  test("apply logs each action, state save and SDK call, without secrets or payloads", async () => {
    enable();
    await applyAll(baseConfig(), emptyState(), fakeAws());
    const text = lines.join("\n");
    expect(text).toMatch(/apply: create @aws\.S3\.data ok \(\d+ms\)/);
    expect(text).toMatch(/apply: dry @aws\.S3\.legacy/);
    expect(text).toMatch(/apply: create @aws\.Lambda\.foo ok/);
    expect(text).toMatch(/state: saved @aws\.S3\.data \{"outputs":\["arn","region"\]\}/);
    expect(text).toMatch(/aws\.s3: CreateBucketCommand ok \(\d+ms\) \{"request":\{"Bucket":"data"/);
    expect(text).toMatch(/aws\.lambda: CreateFunctionCommand ok/);
    expect(text).toMatch(/aws\.iam: CreateRoleCommand ok/);
    expect(text).not.toContain("--enable-source-maps");
    expect(text).toContain('"Environment":"[redacted]"');
    expect(text).toContain('"ZipFile":"[redacted]"');
  });

  test("IAM and bucket policy documents are never logged", async () => {
    enable();
    await applyAll(baseConfig(), emptyState(), fakeAws());
    const text = lines.join("\n");
    expect(text).toMatch(/aws\.iam: PutRolePolicyCommand ok/);
    expect(text).toMatch(/aws\.iam: CreateRoleCommand ok/);
    expect(text).toContain('"PolicyDocument":"[redacted]"');
    expect(text).toContain('"AssumeRolePolicyDocument":"[redacted]"');
    expect(text).not.toContain("s3:PutObject");
    expect(text).not.toContain("sts:AssumeRole");
  });

  test("apply logs a failing SDK call and the failing action", async () => {
    enable();
    const failing = fakeAws({
      CreateRoleCommand: () => {
        throw Object.assign(new Error("not allowed"), { name: "AccessDenied" });
      },
    });
    await expect(applyAll(baseConfig(), emptyState(), failing)).rejects.toThrow("not allowed");
    const text = lines.join("\n");
    expect(text).toMatch(/aws\.iam: CreateRoleCommand failed \(\d+ms\): AccessDenied: not allowed/);
    expect(text).toMatch(/apply: create @aws\.Lambda\.foo failed/);
  });

  test("nothing is written when CG_DEBUG is off", async () => {
    lines.length = 0;
    setDebugSink((line) => void lines.push(line));
    await applyAll(baseConfig(), emptyState(), fakeAws());
    expect(lines).toEqual([]);
  });

  test("Gandi requests are logged with status and timing but never the token", async () => {
    enable();
    const sent: string[] = [];
    const driver = new GandiDnsDriver("example.com", {
      token: "pat-very-secret",
      fetch: (async (_url: string, init: RequestInit) => (sent.push(String((init.headers as Record<string, string>).authorization)), new Response(null, { status: 201 }))) as unknown as typeof fetch,
    });
    await driver.upsert({ name: "www.example.com", type: "CNAME", values: ["d1.cloudfront.net"] });
    expect(sent).toEqual(["Bearer pat-very-secret"]);
    const text = lines.join("\n");
    expect(text).toMatch(/gandi: PUT \/domains\/example\.com\/records\/www\/CNAME -> 201 \(\d+ms\)/);
    expect(text).not.toContain("pat-very-secret");
  });

  test("Gandi failures, including network errors, are logged without the token", async () => {
    enable();
    const rejected = new GandiDnsDriver("example.com", { token: "pat-very-secret", fetch: (async () => Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch });
    await expect(rejected.get("www.example.com", "CNAME")).rejects.toThrow("socket hang up");
    const denied = new GandiDnsDriver("example.com", { token: "pat-very-secret", fetch: (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch });
    await expect(denied.get("www.example.com", "CNAME")).rejects.toThrow(/403/);
    const text = lines.join("\n");
    expect(text).toMatch(/gandi: GET .*CNAME failed \(\d+ms\): Error: socket hang up/);
    expect(text).toMatch(/gandi: GET .*CNAME -> 403/);
    expect(text).not.toContain("pat-very-secret");
  });

  test("blob operations are logged with the key and size, not the contents", async () => {
    process.env.CLOUDGEAR_BLOB_DRIVER = "memory";
    try {
      enable();
      const store = new BlobStore("aws", "://debug-store", { path: "p" });
      await store.put("a.txt", "secret contents");
      await store.getText("a.txt");
      const text = lines.join("\n");
      expect(text).toMatch(/blob: driver ready for aws:\/\/debug-store \{"path":"p\/"\}/);
      expect(text).toMatch(/blob: put p\/a\.txt ok \(\d+ms\) \{"store":"aws:\/\/debug-store","bytes":15/);
      expect(text).toMatch(/blob: get p\/a\.txt ok/);
      expect(text).not.toContain("secret contents");
    } finally {
      delete process.env.CLOUDGEAR_BLOB_DRIVER;
    }
  });

  test("the router logs matching, authentication and dispatch, but never the token or claims", async () => {
    enable();
    const router = new FunctionRouter("aws", {
      mode: "local",
      authenticate: (req) => (req.headers.get("authorization") === "Bearer tok-123" ? { subject: "user-9", claims: { email: "a@b.c" } } : null),
    }).url("GET", "/me", () => ({ ok: true }), { name: "me" });
    await router.fetch(new Request("http://app/me", { headers: { authorization: "Bearer nope" } }));
    await router.fetch(new Request("http://app/me", { headers: { authorization: "Bearer tok-123" } }));
    await router.fetch(new Request("http://app/missing"));
    await router.fetch(new Request("http://app/me", { method: "POST" }));
    const text = lines.join("\n");
    expect(text).toContain("router: GET request");
    expect(text).toContain('router: matched GET /me {"name":"me","public":false,"params":[]}');
    expect(text).toContain("router: rejected GET /me: no valid principal");
    expect(text).toContain("router: authenticated GET /me");
    expect(text).toMatch(/router: local call GET \/me ok/);
    expect(text).toContain("router: local GET /me -> 200");
    expect(text).toContain("router: no route for GET /missing");
    expect(text).toContain("router: method not allowed for POST");
    for (const secret of ["tok-123", "user-9", "a@b.c"]) expect(text).not.toContain(secret);
  });

  test("remote calls log the target host, whether they were signed and the status, not the body", async () => {
    enable();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    try {
      const router = new FunctionRouter("aws", {
        endpoints: { "GET /x": "https://abc.lambda-url.eu-west-1.on.aws/" },
        credentials: async () => ({ accessKeyId: "AKID-secret", secretAccessKey: "sk-secret" }),
        region: "eu-west-1",
      }).url("GET", "/x", () => ({}), { name: "x" });
      await router.fetch(new Request("http://app/x?q=private"));
    } finally {
      globalThis.fetch = original;
    }
    const text = lines.join("\n");
    expect(text).toMatch(/router: POST abc\.lambda-url\.eu-west-1\.on\.aws\/ ok \(\d+ms\) \{"route":"GET \/x","signed":true/);
    expect(text).toContain("router: remote GET /x -> 200");
    for (const secret of ["AKID-secret", "sk-secret", "q=private"]) expect(text).not.toContain(secret);
  });

  test("the Lambda adapter logs the request, the verification outcome and the response", async () => {
    enable();
    const handler = createHandler(async () => ({ ok: true }), [{ method: "GET", path: "/x" }], { authenticate: async (req) => (req.headers.get("x-t") === "tok-9f3a" ? { subject: "u", claims: {} } : null) });
    const event = (headers: Record<string, string>, rawPath = "/x") => ({ rawPath, headers, requestContext: { http: { method: "GET" } } });
    await handler(event({}));
    await handler(event({ "x-t": "tok-9f3a" }));
    await handler({ source: "aws.events", time: "2026-10-26T10:00:00Z" });
    const text = lines.join("\n");
    expect(text).toContain("lambda: rejected: no valid token");
    expect(text).toContain("lambda: token verified");
    expect(text).toContain("lambda: GET request");
    expect(text).toMatch(/lambda: handler ok/);
    expect(text).toContain("lambda: responded 200");
    expect(text).toContain("lambda: scheduled event");
    expect(text).not.toContain("tok-9f3a");
  });

  test("concrete paths of matched requests are not logged, so path parameters stay out", async () => {
    enable();
    const router = new FunctionRouter("aws", { mode: "local" }).url("GET", "/reset/{code}", () => ({ ok: true }), { name: "reset" });
    await router.fetch(new Request("http://app/reset/secret-code-123?x=1"));
    const handler = createHandler(async () => ({ ok: true }), [{ method: "GET", path: "/reset/{code}" }]);
    await handler({ rawPath: "/reset/secret-code-123", headers: {}, requestContext: { http: { method: "GET" } } });
    const text = lines.join("\n");
    expect(text).toContain("router: matched GET /reset/{code}");
    expect(text).not.toContain("secret-code-123");
  });

  test("a malformed invoke body is reported without quoting it", async () => {
    enable();
    const handler = createHandler(async () => ({ ok: true }), [{ method: "POST", path: "/x" }]);
    const res = await handler({
      rawPath: "/x",
      body: "my-password-is-hunter2",
      headers: { "content-type": "application/vnd.cloudgear.invoke+json" },
      requestContext: { http: { method: "POST" } },
    });
    expect(res.statusCode).toBe(400);
    const text = lines.join("\n");
    expect(text).toContain("lambda: bad request: SyntaxError: invalid input");
    expect(text).not.toContain("hunter2");
  });
});

describe("the CLI", () => {
  const root = path.join(import.meta.dir, "..");
  const entry = path.join(root, "examples", "router-app", "main.ts");
  const run = (dir: string, env: Record<string, string>, ...args: string[]) => {
    const proc = Bun.spawnSync(["bun", path.join(root, "src", "cli.ts"), ...args, "--config", path.join(dir, "cloudgear.prototxt")], {
      cwd: dir,
      env: { ...process.env, AWS_REGION: "eu-west-1", CG_DEBUG: "", ...env },
    });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  };

  test("CG_DEBUG=true adds debug lines on stderr for generate and plan, and leaves stdout alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-debug-cli-"));
    const quiet = run(dir, {}, "generate", entry, "--project", "demo");
    expect(quiet.err).toBe("");
    const generated = run(dir, { CG_DEBUG: "true" }, "generate", entry, "--project", "demo");
    expect(generated.err).toMatch(/\[cg:debug [\d:.]+\] cli: command generate/);
    expect(generated.err).toMatch(/generate: analyzed \{"provider":"aws"/);
    expect(generated.err).toMatch(/generate: bundle foo ok/);
    expect(generated.err).toMatch(/generate: bundled foo \{"file":".*index\.mjs","sha256":"[0-9a-f]{64}","bytes":\d+\}/);
    expect(generated.err).toMatch(/generate: config written/);
    expect(generated.out).toBe(quiet.out);

    const planned = run(dir, { CG_DEBUG: "true" }, "plan");
    expect(planned.err).toMatch(/cli: state loaded \{"entries":0\}/);
    expect(run(dir, {}, "plan").err).toBe("");
  });

  test("a failure prints the stack only when debugging", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-debug-fail-"));
    const quiet = run(dir, {}, "plan");
    expect(quiet.code).toBe(1);
    expect(quiet.err).not.toContain("    at ");
    const loud = run(dir, { CG_DEBUG: "true" }, "plan");
    expect(loud.err).toMatch(/cli: failed: Error: .*not found/);
    expect(loud.err).toContain("    at ");
  });
});
