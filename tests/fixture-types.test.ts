import { expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";

setDefaultTimeout(120_000);

// Fixtures are excluded from the main typecheck; these show the documented options type-check.
test("the secrets and events fixtures type-check against the public types", async () => {
  const run = Bun.spawn(["bunx", "tsc", "--noEmit", "-p", "tsconfig.fixtures.json"], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  expect(out).toBe("");
  expect(code).toBe(0);
});
