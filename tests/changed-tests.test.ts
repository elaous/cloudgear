import { describe, expect, test } from "bun:test";
import { planTests } from "../scripts/changed-tests";

describe("planTests", () => {
  test("documentation alone runs nothing", () => {
    expect(planTests(["README.md", "LICENSE", ".github/PULL_REQUEST_TEMPLATE.md"])).toMatchObject({ mode: "none", tests: [] });
  });

  test("manifests, lockfile, scripts, workflows and fixtures run everything", () => {
    for (const file of ["package.json", "bun.lock", "tsconfig.json", "scripts/changed-tests.ts", ".github/workflows/pr.yml", "tests/fixtures/router/a.ts"]) {
      expect(planTests([file]).mode).toBe("all");
    }
  });

  test("a changed test runs itself", () => {
    expect(planTests(["tests/tags.test.ts"])).toMatchObject({ mode: "targeted", tests: ["tests/tags.test.ts"] });
  });

  test("a leaf module runs the tests that import it", () => {
    const plan = planTests(["src/secrets/envfile.ts"]);
    expect(plan.mode).toBe("targeted");
    expect(plan.tests).toContain("tests/secrets-app.test.ts");
  });

  test("a CLI change runs the tests that spawn it", () => {
    expect(planTests(["src/cli.ts"]).tests).toContain("tests/cli.test.ts");
  });

  test("a widely imported module runs everything", () => {
    expect(planTests(["packages/debug/index.ts"]).mode).toBe("all");
  });

  test("an unknown or deleted source file runs everything", () => {
    expect(planTests(["src/does-not-exist.ts"]).mode).toBe("all");
  });
});
