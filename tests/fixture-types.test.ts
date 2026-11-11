import { expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";

setDefaultTimeout(120_000);

// Valid fixtures are checked by tsconfig.fixtures.json.
// Compile-failing fixtures go in tsconfig.fixtures.json's exclude.
test("the secrets and events fixtures type-check against the public types", async () => {
  const run = Bun.spawn([process.execPath, "node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.fixtures.json"], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  expect(out.trim()).toBe("");
  expect(code).toBe(0);
});
