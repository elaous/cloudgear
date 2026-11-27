import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvReport } from "../src/envreport";
import { localVariables, updateLocalEnv } from "../src/localenv";

const dirs: string[] = [];
const fileIn = (content?: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-env-"));
  dirs.push(dir);
  const file = path.join(dir, "local.env");
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const use = (required: boolean, provided: EnvReport["functions"][string]["variables"][string]["provided"]) => ({ required, files: ["a.ts"], provided });
const report = (variables: EnvReport["functions"][string]["variables"], more: EnvReport["functions"] = {}): EnvReport => ({ functions: { api: { routes: [], dynamic: [], variables }, ...more } });

const REPORT = report({
  DB_URL: use(true, null),
  STRIPE_KEY: use(true, "secret"),
  SENTRY_DSN: use(false, null),
  AWS_REGION: use(true, "platform"),
  CLOUDGEAR_BLOB_DATA: use(true, "resource"),
});

describe("localVariables", () => {
  test("lists what the code reads except what the platform or cloudgear sets", () => {
    expect(localVariables(REPORT)).toEqual({ required: ["DB_URL", "STRIPE_KEY"], optional: ["SENTRY_DSN"] });
  });

  test("a variable one function requires is required, whatever the others do", () => {
    const two = report({ A: use(false, null) }, { worker: { routes: [], dynamic: [], variables: { A: use(true, null), B: use(false, "option") } } });
    expect(localVariables(two)).toEqual({ required: ["A"], optional: ["B"] });
  });
});

describe("updateLocalEnv", () => {
  test("creates the file with required names set empty and optional ones commented", () => {
    const file = fileIn();
    const update = updateLocalEnv(file, REPORT);
    expect(update).toEqual({ file, created: true, added: ["DB_URL", "STRIPE_KEY", "SENTRY_DSN"] });
    expect(fs.readFileSync(file, "utf8")).toBe("# Added by `cloudgear generate`: variables the functions read. Values stay yours.\nDB_URL=\nSTRIPE_KEY=\n# SENTRY_DSN=\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test("keeps every existing line and adds only the names that are missing", () => {
    const existing = "# mine\nDB_URL=postgres://x\nexport STRIPE_KEY=sk_test\n\n";
    const file = fileIn(existing);
    const update = updateLocalEnv(file, REPORT);
    expect(update).toMatchObject({ created: false, added: ["SENTRY_DSN"] });
    expect(fs.readFileSync(file, "utf8")).toBe(`${existing}\n# Added by \`cloudgear generate\`: variables the functions read. Values stay yours.\n# SENTRY_DSN=\n`);
  });

  test("a commented-out name counts as declared, so it is not added again", () => {
    const file = fileIn("# SENTRY_DSN=\nDB_URL=1\nSTRIPE_KEY=2\n");
    expect(updateLocalEnv(file, REPORT).added).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe("# SENTRY_DSN=\nDB_URL=1\nSTRIPE_KEY=2\n");
  });

  test("running twice changes nothing the second time, and the header appears once", () => {
    const file = fileIn();
    updateLocalEnv(file, REPORT);
    const first = fs.readFileSync(file, "utf8");
    expect(updateLocalEnv(file, REPORT).added).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(first);
    updateLocalEnv(file, report({ NEW_ONE: use(true, null) }));
    expect(fs.readFileSync(file, "utf8").split("Added by").length).toBe(2);
    expect(fs.readFileSync(file, "utf8")).toContain("NEW_ONE=");
  });

  test("a name that merely starts with a declared one is still added", () => {
    const file = fileIn("DB_URL_READ=1\n");
    expect(updateLocalEnv(file, report({ DB_URL: use(true, null) })).added).toEqual(["DB_URL"]);
  });

  test("names with regular expression characters are matched literally", () => {
    const file = fileIn("A.B=1\n");
    expect(updateLocalEnv(file, report({ "A.B": use(true, null), AXB: use(true, null) })).added).toEqual(["AXB"]);
  });

  test("an existing file's mode is not changed", () => {
    const file = fileIn("X=1\n");
    fs.chmodSync(file, 0o644);
    updateLocalEnv(file, REPORT);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });
});
