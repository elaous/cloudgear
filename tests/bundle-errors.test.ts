import { expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeBuildFailure } from "../src/build/bundle";
import { generate } from "../src/generate";

setDefaultTimeout(30_000);

test("a function that imports a missing file fails with what could not be resolved and where", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-err-"));
  try {
    const entry = path.join(import.meta.dir, "fixtures", "router", "bundle", "missing-import.ts");
    const failure = await generate({ entry, configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "app" }).then(
      () => undefined,
      (err: Error) => err,
    );
    expect(failure?.message).toMatch(/Bundling "api" failed/);
    expect(failure?.message).toMatch(/Could not resolve: "\.\/does-not-exist\.generated"/);
    expect(failure?.message).toMatch(/missing-import\.ts:2/);
    expect(failure?.message).toMatch(/usually made by a build step of yours/);
    expect(failure?.message).not.toBe("Bundle failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("causes are listed once each, and a plain error is shown as it is", () => {
  const one = { message: "Could not resolve: x", position: { file: "a.ts", line: 3 } };
  expect(describeBuildFailure(new AggregateError([one, one, { message: "other" }], "Bundle failed"))).toBe("Could not resolve: x (a.ts:3)\nother");
  expect(describeBuildFailure(new Error("boom"))).toBe("boom");
});
