import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatMissingEnv, missingEnv, type EnvReport } from "../src/envreport";
import { checkEnvironment } from "../src/envcheck";
import { decodeConfig } from "../src/config/schema";
import { generate } from "../src/generate";
import { resetMemorySecrets } from "@cloudgear/secrets/drivers/memory";
import { createMemorySecretDriver } from "@cloudgear/secrets/drivers/memory";

setDefaultTimeout(40_000);

const root = path.join(import.meta.dir, "..");
const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "envvars", `${name}.ts`);

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "envvars-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const generated = async (name: string) => {
  const configPath = path.join(dir, `${name}.prototxt`);
  const { warnings, env } = await generate({ entry: fixture(name), configPath, buildDir: path.join(dir, `${name}-build`), project: "app" });
  return { configPath, warnings, report: env };
};

describe("the environment scan", () => {
  test("follows a dynamic import with a literal specifier, including what that file imports", async () => {
    const { report } = await generated("lazy");
    const v = Object.values(report.functions)[0]!.variables;
    expect(v.LAZY_VAR).toMatchObject({ required: true, provided: null });
    expect(v.LAZY_VAR!.files.some((f) => f.endsWith("lazy-target.ts"))).toBe(true);
    expect(v.LAZY_HELPER_VAR).toMatchObject({ required: false, provided: null });
  });

  test("a dynamic import in a function that is not run is not followed, and a computed import is left alone", async () => {
    const sibling = (await generated("lazy-sibling")).report.functions.api!;
    expect(Object.keys(sibling.variables)).toEqual(["SIBLING_USED"]);
    const computed = (await generated("lazy-computed")).report.functions.api!;
    expect(computed.variables).toEqual({});
    expect(computed.dynamic).toEqual([]);
  });

  test("lists what each function's code reads, with how it is provided", async () => {
    const { report, configPath } = await generated("main");
    expect(configPath.endsWith(".prototxt")).toBe(true);
    expect(fs.existsSync(path.join(dir, "main.env.json"))).toBe(false);
    expect(report.functions.api!.routes).toEqual(["GET /api"]);
    const v = report.functions.api!.variables;
    expect(v.STRIPE_KEY).toMatchObject({ required: true, provided: "secret" });
    expect(v.LITERAL).toMatchObject({ required: true, provided: "option" });
    expect(v.AWS_REGION!.provided).toBe("platform");
    expect(v.TZ!.provided).toBe("platform");
    expect(v.DB_URL).toMatchObject({ required: true, provided: null });
    expect(v.DB_URL!.files).toEqual(expect.arrayContaining([expect.stringMatching(/lib\.ts$/)]));
    expect(v.API_TOKEN).toMatchObject({ required: true, provided: null });
    expect(v.MODE).toMatchObject({ required: true, provided: null });
  });

  test("a fallback, a presence check or a default makes a read optional", async () => {
    const v = (await generated("main")).report.functions.api!.variables;
    expect(v.REGION!.required).toBe(false);
    expect(v.FEATURE_FLAG!.required).toBe(false);
    expect(v.OTHER!.required).toBe(false);
    expect(v.RETRIES!.required).toBe(false);
  });

  test("only code the function imports counts, per function; imports of a shared file apply to both", async () => {
    const { report } = await generated("main");
    expect(Object.keys(report.functions.api!.variables)).not.toContain("NOT_IMPORTED");
    expect(Object.keys(report.functions.api!.variables)).not.toContain("WORKER_ONLY");
    expect(Object.keys(report.functions.worker!.variables).sort()).toEqual(["DB_URL", "WORKER_ONLY"]);
    expect(Object.keys(report.functions.api!.variables)).toContain("REGION");
  });

  test("writes are not reads, and comparisons, checks and chains make a read optional", async () => {
    const v = (await generated("forms")).report.functions.api!.variables;
    for (const name of ["ASSIGNED_ONLY", "DELETED", "PROTOTYPE_CALL", "hasOwnProperty"]) expect(Object.hasOwn(v, name)).toBe(false);
    for (const name of ["DEFAULTED", "NODE_ENV", "DEBUG_FLAG", "TRIMMED", "SAME", "SOFT_CHECK"]) expect(v[name]!.required).toBe(false);
    expect(v.NODE_ENV!.provided).toBe("platform");
    expect(v.TZ).toBeUndefined();
  });

  test("a numeric conversion before a || fallback keeps the read optional", async () => {
    const v = (await generated("optional")).report.functions.api!.variables;
    for (const name of ["RATE", "LEVEL", "NESTED", "FLAG"]) expect(v[name]!.required).toBe(false);
  });

  test("a conversion whose fallback can never run does not", async () => {
    const v = (await generated("optional")).report.functions.api!.variables;
    for (const name of ["NEEDED", "STRINGY", "NULLISH", "BARE"]) expect(v[name]!.required).toBe(true);
  });

  test("a throwing guard around Boolean() still requires the variable", async () => {
    expect((await generated("optional")).report.functions.api!.variables.GUARDED!.required).toBe(true);
  });

  test("optionalEnv on the router marks variables as tolerated", async () => {
    const v = (await generated("optional")).report.functions.api!.variables;
    expect(v.SENTRY_DSN!.required).toBe(false);
  });

  test("an optionalEnv name that nothing reads is warned about, and one that is not a name is rejected", async () => {
    expect((await generated("optional")).warnings.some((w) => /optionalEnv "TYPO_NAME" is not read/.test(w))).toBe(true);
    const bad = fixture("optional-bad");
    await expect(generate({ entry: bad, configPath: path.join(dir, "bad.prototxt"), buildDir: path.join(dir, "bad-build"), project: "app" })).rejects.toThrow(/not an environment variable name/);
  });

  test("a presence check that throws means the variable is required", async () => {
    const v = (await generated("forms")).report.functions.api!.variables;
    expect(v.MUST_HAVE!.required).toBe(true);
  });

  test("aliases, globalThis, casts and non-null assertions are resolved to names", async () => {
    const { report } = await generated("forms");
    const v = report.functions.api!.variables;
    expect(v.ALIASED!.required).toBe(true);
    expect(v.VIA_GLOBAL!.required).toBe(true);
    expect(v.CAST!.required).toBe(true);
    expect(v.BANG!.required).toBe(true);
    expect(report.functions.api!.dynamic).toEqual([]);
  });

  test("a function includes what it calls in its file, and not the functions it does not", async () => {
    const { report } = await generated("forms");
    // Module-level `new Service()` runs at load; its field reads count.
    expect(Object.keys(report.functions.caller!.variables).sort()).toEqual(["CLASS_FIELD", "HELPER_VAR", "OTHER_FN_VAR"]);
    expect(Object.keys(report.functions.other!.variables).sort()).toEqual(["CLASS_FIELD", "OTHER_FN_VAR"]);
    expect(Object.keys(report.functions.api!.variables)).not.toContain("HELPER_VAR");
  });

  test("a method also runs its class's field initializers", async () => {
    const { report } = await generated("forms");
    expect(report.functions["service-handle"]?.variables.CLASS_FIELD ?? report.functions[Object.keys(report.functions).find((n) => /handle/.test(n))!]!.variables.CLASS_FIELD).toMatchObject({ required: true });
  });

  test("a computed read or a spread is reported as dynamic and warned about", async () => {
    const { report, warnings } = await generated("dynamic");
    expect(report.functions.api!.dynamic).toHaveLength(2);
    expect(Object.keys(report.functions.api!.variables)).toEqual(["FIXED"]);
    expect(warnings.some((w) => /cannot be listed/.test(w))).toBe(true);
  });

  test("a wildcard secret path may provide any variable", async () => {
    const { report } = await generated("wildcard");
    expect(report.functions.api!.variables.ANYTHING!.provided).toBe("secret-wildcard");
    expect(missingEnv(report)).toEqual([]);
  });

  test("missing variables are the required ones nothing provides", async () => {
    const { report } = await generated("main");
    expect(missingEnv(report).map((m) => `${m.function}:${m.variable}`).sort()).toEqual(["api:API_TOKEN", "api:DB_URL", "api:MODE", "worker:DB_URL", "worker:WORKER_ONLY"]);
  });

  test("the message names each function, variable and file", () => {
    const report: EnvReport = { functions: { api: { routes: [], dynamic: [], variables: { A: { required: true, files: ["x.ts"], provided: null } } } } };
    expect(formatMissingEnv(missingEnv(report))).toContain("api: A (x.ts)");
  });
});

describe("the CLI", () => {
  const cli = (command: string, config: string, ...extra: string[]) => {
    const proc = Bun.spawnSync(["bun", path.join(root, "src", "cli.ts"), command, "--config", config, ...extra], { cwd: dir, env: { ...process.env, AWS_REGION: "eu-west-1" } });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  };

  test("generate fails while required variables are not provided, after writing the config and local.env", () => {
    const configPath = path.join(dir, "cli-main.prototxt");
    const localEnv = path.join(dir, "cli-main.env");
    const res = cli("generate", configPath, fixture("main"), "--project", "app", "--local-env", localEnv);
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/nothing provides/);
    expect(res.err).toMatch(/api: .*DB_URL/);
    expect(res.err).toMatch(/--allow-missing-env/);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(localEnv, "utf8")).toMatch(/^DB_URL=$/m);
    expect(res.out).toMatch(/created \d+ variable\(s\) in .*cli-main\.env: /);
  });

  test("--allow-missing-env generates anyway", () => {
    const configPath = path.join(dir, "cli-allow.prototxt");
    const res = cli("generate", configPath, fixture("main"), "--project", "app", "--no-local-env", "--allow-missing-env");
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(dir, "local.env"))).toBe(false);
  });

  test("generate removes the old environment report", () => {
    const configPath = path.join(dir, "cli-old.prototxt");
    fs.writeFileSync(path.join(dir, "cli-old.env.json"), "{}");
    expect(cli("generate", configPath, fixture("wildcard"), "--project", "app", "--no-local-env").code).toBe(0);
    expect(fs.existsSync(path.join(dir, "cli-old.env.json"))).toBe(false);
  });

  test("--local-env creates a missing directory and a directory at the path is refused", () => {
    const configPath = path.join(dir, "cli-dirs.prototxt");
    const nested = path.join(dir, "nodir", "deeper", "x.env");
    expect(cli("generate", configPath, fixture("main"), "--project", "app", "--allow-missing-env", "--local-env", nested).code).toBe(0);
    expect(fs.readFileSync(nested, "utf8")).toMatch(/^DB_URL=$/m);
    const res = cli("generate", configPath, fixture("main"), "--project", "app", "--allow-missing-env", "--local-env", path.join(dir, "nodir"));
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/is not a file/);
  });

  test("local.env beside the config is the default", () => {
    const sub = path.join(dir, "default-env");
    fs.mkdirSync(sub);
    const res = cli("generate", path.join(sub, "cloudgear.prototxt"), fixture("main"), "--project", "app", "--allow-missing-env");
    expect(res.code).toBe(0);
    expect(fs.readFileSync(path.join(sub, "local.env"), "utf8")).toMatch(/^DB_URL=$/m);
  });
});

describe("checkEnvironment", () => {
  const load = (configPath: string) => decodeConfig(fs.readFileSync(configPath, "utf8"));
  const prior = process.env.CLOUDGEAR_SECRETS_DRIVER;

  test("passes when everything is provided and the secrets are stored", async () => {
    const { configPath } = await generated("wildcard");
    process.env.CLOUDGEAR_SECRETS_DRIVER = "memory";
    resetMemorySecrets();
    try {
      await expect(checkEnvironment(load(configPath), "eu-west-1")).resolves.toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.CLOUDGEAR_SECRETS_DRIVER;
      else process.env.CLOUDGEAR_SECRETS_DRIVER = prior;
    }
  });

  const withStore = async (stored: Record<string, string>, run: (configPath: string) => Promise<void>) => {
    const { configPath } = await generated("secret-bound");
    process.env.CLOUDGEAR_SECRETS_DRIVER = "memory";
    resetMemorySecrets();
    for (const [name, value] of Object.entries(stored)) await createMemorySecretDriver().put(name, value);
    try {
      await run(configPath);
    } finally {
      if (prior === undefined) delete process.env.CLOUDGEAR_SECRETS_DRIVER;
      else process.env.CLOUDGEAR_SECRETS_DRIVER = prior;
    }
  };

  test("fails when a declared secret is not stored, naming it", async () => {
    await withStore({}, async (configPath) => {
      await expect(checkEnvironment(load(configPath), "eu-west-1")).rejects.toThrow(/not stored: \/app\/STRIPE_KEY/);
    });
  });

  test("passes once the secret is stored", async () => {
    await withStore({ "/app/STRIPE_KEY": "sk" }, async (configPath) => {
      await expect(checkEnvironment(load(configPath), "eu-west-1")).resolves.toBeUndefined();
    });
  });
});
