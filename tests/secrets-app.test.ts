import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHandler } from "@cloudgear/functions/drivers/aws";
import { createMemorySecretDriver, resetMemorySecrets } from "@cloudgear/secrets/drivers/memory";
import { decodeConfig, encodeConfig, type SecretBindingSpec } from "../src/config/schema";
import { plan } from "../src/deploy/plan";
import { applyAll, baseConfig, emptyState, fakeAws, fn } from "./helpers";
import { secretStatements } from "../src/deploy/aws/secrets";
import { generate } from "../src/generate";
import { checkEnvFileIgnored, parseEnvFile, readSecretRef, secretGroups, secretStatus, setSecrets } from "../src/secrets";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "secrets", `${name}.ts`);
const generated = async (name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-"));
  const configPath = path.join(dir, "c.prototxt");
  const { config } = await generate({ entry: fixture(name), configPath, buildDir: path.join(dir, "b"), project: "app" });
  return { config, text: fs.readFileSync(configPath, "utf8") };
};

describe("analysis", () => {
  test("a path call lists the secrets a function reads", async () => {
    const { config } = await generated("basic");
    expect(config.function[0]!.secret).toEqual([
      { provider: "aws", service: "ssm", path: "/cloudgear/myproject", name: "STRIPE_KEY", env: "STRIPE_KEY" },
      { provider: "aws", service: "ssm", path: "/cloudgear/myproject", name: "DB_URL", env: "DB_URL" },
    ]);
  });

  test("an object maps variable names to secret names", async () => {
    const { config } = await generated("renamed");
    expect(config.function[0]!.secret).toEqual([{ provider: "aws", service: "secretsmanager", path: "/cloudgear/myproject", name: "stripe-key", env: "API_KEY" }]);
  });

  test("a wildcard path binds every secret under it", async () => {
    const { config } = await generated("wildcard");
    expect(config.function[0]!.secret).toEqual([{ provider: "aws", service: "ssm", path: "/cloudgear/myproject", name: "", env: "", all: true }]);
  });

  test("a DNS token is recorded as a reference, never a value", async () => {
    const { config, text } = await generated("dns-token");
    expect(config.certificate[0]!.dns.token).toEqual({ provider: "aws", service: "ssm", path: "/cloudgear/myproject", name: "GANDI_TOKEN" });
    expect(text).toContain("GANDI_TOKEN");
  });

  test("a computed secret name is rejected", async () => {
    await expect(generated("computed-name")).rejects.toThrow(/secret name must be a string literal/);
  });

  test("the config round-trips", async () => {
    const { config } = await generated("renamed");
    expect(decodeConfig(encodeConfig(config)).function[0]!.secret).toEqual(config.function[0]!.secret);
  });
});

describe("IAM", () => {
  const context = { account: "123456789012", region: "us-east-1" };
  const binding = (over: Partial<SecretBindingSpec>): SecretBindingSpec => ({ provider: "aws", service: "ssm", path: "/app", name: "A", env: "A", ...over });

  test("an SSM binding is scoped to its exact parameter", () => {
    expect(secretStatements([binding({})], context)).toEqual([
      { Effect: "Allow", Action: ["ssm:GetParameter", "ssm:GetParameters"], Resource: "arn:aws:ssm:us-east-1:123456789012:parameter/app/A" },
    ]);
  });

  test("a Secrets Manager binding allows the version suffix only", () => {
    expect(secretStatements([binding({ service: "secretsmanager", name: "k" })], context)).toEqual([
      { Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: "arn:aws:secretsmanager:us-east-1:123456789012:secret:/app/k-*" },
    ]);
  });

  test("a wildcard adds listing under the path", () => {
    const statements = secretStatements([binding({ all: true, name: "", env: "" })], context);
    expect(statements.flatMap((s) => s.Action)).toContain("ssm:GetParametersByPath");
  });

  test("a region on the binding wins over the function's", () => {
    const [statement] = secretStatements([binding({ region: "eu-west-1" })], context);
    expect(statement!.Resource).toContain("eu-west-1");
  });

  test("kms:Decrypt is granted only for an explicit key", () => {
    expect(secretStatements([binding({})], context).flatMap((s) => s.Action)).not.toContain("kms:Decrypt");
    const key = "1234abcd-12ab-34cd-56ef-1234567890ab";
    const statements = secretStatements([binding({ kms_key: key })], context);
    expect(statements.at(-1)).toEqual({ Effect: "Allow", Action: ["kms:Decrypt"], Resource: [`arn:aws:kms:us-east-1:123456789012:key/${key}`] });
  });

  test("a key alias cannot be scoped", () => {
    expect(() => secretStatements([binding({ kms_key: "alias/mine" })], context)).toThrow(/alias cannot be scoped/);
  });

  test("no bindings means no statements", () => {
    expect(secretStatements(undefined, context)).toEqual([]);
  });
});

describe("env files", () => {
  test("parses quotes, comments, export and blank lines", () => {
    const values = parseEnvFile(`# comment\n\nA=1\nexport B="two words" # trailing\nC='lit $x'\nD=plain # note\nE="line\\nbreak"\nF=\n`);
    expect(values).toEqual({ A: "1", B: "two words", C: "lit $x", D: "plain", E: "line\nbreak", F: "" });
  });

  test("a multi-line quoted value is kept whole", () => {
    expect(parseEnvFile('KEY="a\nb"\n').KEY).toBe("a\nb");
  });

  test("errors name the file and line but not the value", () => {
    expect(() => parseEnvFile("A=1\nnot valid\n", "x.env")).toThrow(/x\.env:2: expected KEY=value/);
    expect(() => parseEnvFile('A="secret-value', "x.env")).toThrow(/x\.env:1: .*never closed/);
    try {
      parseEnvFile('A="secret-value', "x.env");
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-value");
    }
  });
});

describe("git guard", () => {
  let dir: string;
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
    git("init", "-q");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("an ignored file passes", () => {
    fs.writeFileSync(path.join(dir, ".gitignore"), ".env*\n");
    fs.writeFileSync(path.join(dir, ".env.prod"), "A=1\n");
    expect(() => checkEnvFileIgnored(path.join(dir, ".env.prod"), false)).not.toThrow();
  });

  test("a file git does not ignore is refused unless allowed", () => {
    fs.writeFileSync(path.join(dir, "prod.env"), "A=1\n");
    expect(() => checkEnvFileIgnored(path.join(dir, "prod.env"), false)).toThrow(/not ignored by git/);
    expect(() => checkEnvFileIgnored(path.join(dir, "prod.env"), true)).not.toThrow();
  });

  test("a tracked file is always refused", () => {
    fs.writeFileSync(path.join(dir, "prod.env"), "A=1\n");
    git("add", "-f", "prod.env");
    expect(() => checkEnvFileIgnored(path.join(dir, "prod.env"), true)).toThrow(/tracked by git/);
  });
});

describe("secrets commands", () => {
  const prior = process.env.CLOUDGEAR_SECRETS_DRIVER;
  beforeEach(() => {
    process.env.CLOUDGEAR_SECRETS_DRIVER = "memory";
    resetMemorySecrets();
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.CLOUDGEAR_SECRETS_DRIVER;
    else process.env.CLOUDGEAR_SECRETS_DRIVER = prior;
  });

  test("groups collect function names and DNS tokens per path", async () => {
    const { config } = await generated("dns-token");
    const [group] = secretGroups(config);
    expect([...group!.names]).toEqual(["GANDI_TOKEN"]);
  });

  test("set stores declared names, reports missing and undeclared ones", async () => {
    const { config } = await generated("basic");
    const result = await setSecrets(config, { STRIPE_KEY: "sk", OTHER: "x" }, { region: "us-east-1" });
    expect(result.written).toEqual([{ path: "/cloudgear/myproject", names: ["STRIPE_KEY"] }]);
    expect(result.missing).toEqual(["/cloudgear/myproject/DB_URL"]);
    expect(result.undeclared).toEqual(["OTHER"]);
    expect(await createMemorySecretDriver().get("/cloudgear/myproject/STRIPE_KEY")).toBe("sk");
    expect(await createMemorySecretDriver().get("/cloudgear/myproject/OTHER")).toBeNull();
  });

  test("--all stores undeclared names under the only path", async () => {
    const { config } = await generated("basic");
    await setSecrets(config, { EXTRA: "e" }, { all: true });
    expect(await createMemorySecretDriver().get("/cloudgear/myproject/EXTRA")).toBe("e");
  });

  test("a single name that nothing reads is an error", async () => {
    const { config } = await generated("basic");
    await expect(setSecrets(config, { NOPE: "x" }, { only: "NOPE" })).rejects.toThrow(/reads NOPE/);
  });

  test("empty values are skipped", async () => {
    const { config } = await generated("basic");
    const result = await setSecrets(config, { STRIPE_KEY: "", DB_URL: "u" }, {});
    expect(result.empty).toEqual(["STRIPE_KEY"]);
    expect(result.written[0]!.names).toEqual(["DB_URL"]);
  });

  test("status lists present, missing and unused secrets", async () => {
    const { config } = await generated("basic");
    const driver = createMemorySecretDriver();
    await driver.put("/cloudgear/myproject/STRIPE_KEY", "v");
    await driver.put("/cloudgear/myproject/STALE", "v");
    const [status] = await secretStatus(config);
    expect(status).toMatchObject({ present: ["STRIPE_KEY"], missing: ["DB_URL"], unused: ["STALE"] });
  });

  test("a DNS token ref prefers the environment, then the store", async () => {
    const { config } = await generated("dns-token");
    const ref = config.certificate[0]!.dns.token!;
    await createMemorySecretDriver().put("/cloudgear/myproject/GANDI_TOKEN", "from-store");
    expect(await readSecretRef(ref)).toBe("from-store");
    process.env.GANDI_TOKEN = "from-env";
    try {
      expect(await readSecretRef(ref)).toBe("from-env");
    } finally {
      delete process.env.GANDI_TOKEN;
    }
  });

  test("a missing token names the secret, not a value", async () => {
    await expect(readSecretRef({ provider: "aws", service: "ssm", path: "/nowhere", name: "TOK" })).rejects.toThrow(/\/nowhere\/TOK was not found/);
  });
});

describe("handler preparation", () => {
  const event = { rawPath: "/x", requestContext: { http: { method: "GET" } } };
  const routes = [{ method: "GET" as const, path: "/x", name: "x" }];

  test("prepare runs once before requests", async () => {
    let calls = 0;
    const handler = createHandler(async () => ({ ok: true }), routes, { prepare: async () => void calls++ });
    await handler(event);
    await handler(event);
    expect(calls).toBe(1);
  });

  test("a failed preparation answers 500 and is retried", async () => {
    let calls = 0;
    const handler = createHandler(async () => ({ ok: true }), routes, {
      prepare: async () => {
        if (++calls === 1) throw new Error("denied");
      },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      expect((await handler(event)).statusCode).toBe(500);
    } finally {
      console.error = originalError;
    }
    expect((await handler(event)).statusCode).toBe(200);
  });
});

describe("deploy", () => {
  const secret: SecretBindingSpec = { provider: "aws", service: "ssm", path: "/app", name: "KEY", env: "KEY" };

  test("the role policy grants the declared secrets and a change is planned", async () => {
    const state = emptyState();
    const aws = await applyAll(baseConfig({ function: [fn({ secret: [secret] })] }), state);
    const document = JSON.parse(aws.of("PutRolePolicyCommand")[0].PolicyDocument);
    expect(JSON.stringify(document)).toContain("parameter/app/KEY");

    expect(plan(baseConfig({ function: [fn({ secret: [secret] })] }), state).find((a) => a.kind === "function")).toMatchObject({ op: "noop" });
    const changed = plan(baseConfig({ function: [fn({ secret: [{ ...secret, name: "OTHER", env: "OTHER" }] })] }), state);
    expect(changed.find((a) => a.kind === "function")).toMatchObject({ op: "update", changes: ["permissions"] });
  });

  test("a DNS token reaches the DNS driver factory", async () => {
    const tokens: unknown[] = [];
    const ref = { provider: "aws", service: "ssm", path: "/app", name: "TOK" };
    const aws = fakeAws({}, undefined, (_provider, _zone, token) => void tokens.push(token));
    const config = baseConfig({
      function: [],
      certificate: [{ provider: "aws", domain: "cdn.example.com", dns: { provider: "gandi", domain: "cdn.example.com", zone: "example.com", token: ref } }],
    });
    await applyAll(config, emptyState(), aws);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((token) => JSON.stringify(token) === JSON.stringify(ref))).toBe(true);
  });
});
