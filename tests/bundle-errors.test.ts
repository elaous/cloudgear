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

test("an empty AggregateError and a null cause still say something", () => {
  expect(describeBuildFailure(new AggregateError([], "Bundle failed"))).toBe("Bundle failed");
  expect(describeBuildFailure(new AggregateError([null], "x"))).toBe("null");
});

test("a missing package gets no build-step hint, a relative generated file does", () => {
  const missing = (specifier: string) => describeBuildFailure(new AggregateError([{ message: `Could not resolve: "${specifier}"` }], "Bundle failed"));
  expect(missing("@acme/generated-client")).not.toMatch(/build step/);
  expect(missing("openapi-generated")).not.toMatch(/build step/);
  expect(missing("../lib/config.generated.ts")).toMatch(/build step/);
  expect(missing("./generated/index.ts")).toMatch(/build step/);
});

test("a long list is capped and says how many more", () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ message: `error ${i}` }));
  const lines = describeBuildFailure(new AggregateError(many, "Bundle failed")).split("\n");
  expect(lines).toHaveLength(21);
  expect(lines.at(-1)).toBe("... and 25 more");
});

test("the original error is kept as the cause", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-cause-"));
  try {
    const entry = path.join(import.meta.dir, "fixtures", "router", "bundle", "missing-import.ts");
    const failure = (await generate({ entry, configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "app" }).catch((err: Error) => err)) as Error;
    expect(failure.cause).toBeInstanceOf(AggregateError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
