import { describe, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FunctionRouter } from "@cloudgear/functions";
import { generate } from "../src/generate";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", name);

describe("routes handled by a script file at runtime", () => {
  const router = new FunctionRouter("aws", { mode: "local" })
    .url("GET", "/hello", "./fixtures/router/scripts/handlers/hello.ts")
    .url("GET", "/echo/{id}", "./fixtures/router/scripts/handlers/echo.ts", { name: "echo" })
    .url("GET", "/named", "./fixtures/router/scripts/handlers/named.ts")
    .url("GET", "/absent", "./fixtures/router/scripts/handlers/absent.ts");

  test("the path is relative to the file calling url, and the default export runs", async () => {
    const res = await router.fetch(new Request("http://localhost/hello"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: "world" });
  });

  test("path params reach the script as input", async () => {
    const res = await router.fetch(new Request("http://localhost/echo/42"));
    expect(await res.json()).toEqual({ id: "42", echoed: true });
  });

  test("a script without a default function, or a missing one, answers 500", async () => {
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const route of ["/named", "/absent"]) {
        const res = await router.fetch(new Request(`http://localhost${route}`));
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "Route script has no default export function" });
      }
    } finally {
      quiet.mockRestore();
    }
  });

  test("a script route is named after its method and path unless given a name", () => {
    const urls = (router as unknown as { routes: { name: string }[] }).routes.map((r) => r.name);
    expect(urls).toEqual(["GET /hello", "echo", "GET /named", "GET /absent"]);
  });
});

describe("generating for routes handled by a script file", () => {
  test("bundles each script as a function and writes its routes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-scripts-"));
    try {
      const { config } = await generate({ entry: fixture("scripts/main.ts"), configPath: path.join(dir, "cloudgear.prototxt"), buildDir: path.join(dir, "build") });
      expect(config.function.map((f) => [f.name, f.source.export, f.route.map((r) => `${r.method} ${r.path} ${r.name}`)])).toEqual([
        ["handlers-hello", "default", ["GET /hello GET /hello"]],
        ["handlers-save", "default", ["POST /items/{id} saveItem"]],
      ]);
      expect(config.function[1]!.permission).toMatchObject([{ resource: "script-data", action: ["s3:PutObject"] }]);
      for (const name of ["handlers-hello", "handlers-save"]) {
        expect(fs.readFileSync(path.join(dir, "build", name, "entry.ts"), "utf8")).toContain("import { default as fn }");
        expect(fs.existsSync(path.join(dir, "build", name, "index.mjs"))).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
