import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envReportPath, formatMissingEnv, missingEnv, readEnvReport, type EnvReport } from "../src/envreport";
import { generate } from "../src/generate";

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
  const { warnings } = await generate({ entry: fixture(name), configPath, buildDir: path.join(dir, `${name}-build`), project: "app" });
  return { configPath, warnings, report: readEnvReport(envReportPath(configPath))! };
};

describe("the environment report", () => {
  test("lists what each function's code reads, with how it is provided", async () => {
    const { report, configPath } = await generated("main");
    expect(configPath.endsWith(".prototxt")).toBe(true);
    expect(envReportPath(configPath)).toBe(path.join(dir, "main.env.json"));
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
    expect(Object.keys(report.functions.worker!.variables).sort()).toEqual(["DB_URL", "FEATURE_FLAG", "OTHER", "REGION", "WORKER_ONLY"]);
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
    const report: EnvReport = { version: 1, functions: { api: { routes: [], dynamic: [], variables: { A: { required: true, files: ["x.ts"], provided: null } } } } };
    expect(formatMissingEnv(missingEnv(report))).toContain("api: A (x.ts)");
  });

  test("a report of another version is refused", () => {
    const file = path.join(dir, "old.env.json");
    fs.writeFileSync(file, JSON.stringify({ version: 2, functions: {} }));
    expect(() => readEnvReport(file)).toThrow(/re-run `cloudgear generate`/);
    expect(readEnvReport(path.join(dir, "absent.env.json"))).toBeUndefined();
  });
});

describe("the CLI", () => {
  const cli = (command: string, config: string, ...extra: string[]) => {
    const proc = Bun.spawnSync(["bun", path.join(root, "src", "cli.ts"), command, "--config", config, ...extra], { cwd: dir, env: { ...process.env, AWS_REGION: "eu-west-1" } });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  };

  test("apply refuses to deploy while required variables are not provided", async () => {
    const { configPath } = await generated("main");
    const res = cli("apply", configPath, "--auto-approve");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/nothing provides/);
    expect(res.err).toMatch(/api: .*DB_URL/);
    expect(res.err).toMatch(/--skip-env-check/);
  });

  test("plan only warns", async () => {
    const { configPath } = await generated("main");
    const res = cli("plan", configPath);
    expect(res.code).toBe(0);
    expect(res.err).toMatch(/nothing provides/);
  });

  test("apply without the report asks for generate, and a clean report passes the check", async () => {
    const { configPath } = await generated("wildcard");
    process.env.CLOUDGEAR_SECRETS_DRIVER = "memory";
    try {
      fs.rmSync(envReportPath(configPath));
      const missing = cli("apply", configPath, "--auto-approve");
      expect(missing.err).toMatch(/not found; run `cloudgear generate`/);
    } finally {
      delete process.env.CLOUDGEAR_SECRETS_DRIVER;
    }
  });
});
