import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { encodeConfig } from "../src/config/schema";
import { baseConfig } from "./helpers";

const root = path.join(import.meta.dir, "..");

describe("the config proto", () => {
  const header = encodeConfig(baseConfig())
    .split("\n")
    .filter((line) => line.startsWith("# proto-"));
  const hint = (name: string) => header.find((line) => line.startsWith(`# ${name}: `))!.slice(`# ${name}: `.length);

  test("is the file the generated config names, in the buf module", () => {
    const file = hint("proto-file");
    expect(file).toBe("cloudgear/config/v1/config.proto");
    const text = fs.readFileSync(path.join(root, "proto", file), "utf8");
    expect(text).toContain("package cloudgear.config.v1;");
  });

  test("declares the message the generated config names", () => {
    const [packageName, message] = [hint("proto-message").replace(/\.[^.]+$/, ""), hint("proto-message").split(".").at(-1)!];
    const text = fs.readFileSync(path.join(root, "proto", hint("proto-file")), "utf8");
    expect(text).toContain(`package ${packageName};`);
    expect(text).toMatch(new RegExp(`^message ${message} \\{`, "m"));
  });

  test("names every top-level field the encoder writes", () => {
    const text = fs.readFileSync(path.join(root, "proto", hint("proto-file")), "utf8");
    const config = text.slice(text.indexOf("message Config {"), text.indexOf("\n}\n", text.indexOf("message Config {")));
    const declared = [...config.matchAll(/^\s+(?:repeated\s+)?\w+\s+(\w+)\s*=\s*\d+;/gm)].map((m) => m[1]);
    const written = new Set(
      encodeConfig(baseConfig({ region: "eu-west-1" }))
        .split("\n")
        .filter((line) => /^\w/.test(line))
        .map((line) => line.split(/[ :]/)[0]),
    );
    for (const field of written) expect(declared).toContain(field!);
  });
});
