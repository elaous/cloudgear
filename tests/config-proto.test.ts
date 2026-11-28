import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { encodeConfig } from "../src/config/schema";
import { baseConfig, fn } from "./helpers";

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

  test("declares every field the encoder writes, at every level, for a config that sets them all", () => {
    const text = fs.readFileSync(path.join(root, "proto", hint("proto-file")), "utf8");
    const messages = new Map<string, Map<string, string>>();
    let current: Map<string, string> | undefined;
    for (const line of text.split("\n")) {
      const open = /^message (\w+) \{/.exec(line);
      if (open) messages.set(open[1]!, (current = new Map()));
      else if (/^\}/.test(line)) current = undefined;
      else {
        const field = /^\s+(?:repeated\s+)?(map<\w+,\s*\w+>|\w+)\s+(\w+)\s*=\s*\d+;/.exec(line);
        if (field && current) current.set(field[2]!, field[1]!);
      }
    }
    const attached = [{ id: "o1", origin: '{"Id":"o1"}', behavior: [{ path_pattern: "/a/*", behavior: '{"PathPattern":"/a/*","TargetOriginId":"o1"}', position: 1 }] }];
    const secret = { provider: "aws", service: "ssm", region: "eu-west-1", kms_key: "alias/k", path: "/app", name: "TOKEN" };
    const config = baseConfig({
      region: "eu-west-1",
      invoker: ["arn:aws:iam::1:role/r"],
      certificate: [{ provider: "aws", domain: "a.example.com", dns: { provider: "gandi", domain: "a.example.com", zone: "example.com", token: secret }, usage: "cdn", region: "us-east-1", options: { key_algorithm: "RSA_2048" } }],
      cdn: [{ provider: "aws", domain: "a.example.com", certificate: "*.example.com", bucket: "data", path: "web/", options: { price_class: "PriceClass_100" }, attached }],
      api: { provider: "aws", domain: "api.example.com", certificate: "*.example.com", via: "cloudfront", method_routing: true, options: { price_class: "PriceClass_100" }, attached },
      function: [
        {
          ...fn({ options: { tracing: "Active" } }),
          schedule: ["rate(1 hour)"],
          include: ["dist/index.html"],
          pass_request: true,
          response_arg: "helper",
          secret: [{ ...secret, env: "TOKEN", all: true }],
          event: [{ bus: "orders", type: "created", source: "shop" }],
          query_schedule: [{ cron: "0 * * * *", query: { job: "x" } }],
          policy: [{ name: "p", document: "{}" }],
          handler: "bootstrap",
          architecture: "arm64",
          bundle: { path: "bin/x.zip", sha256: "abc", archive: true },
        },
      ],
    });
    const stack: string[] = ["Config"];
    const undeclared: string[] = [];
    for (const raw of encodeConfig(config).split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line === "}") {
        stack.pop();
        continue;
      }
      const key = /^(\w+)/.exec(line)![1]!;
      // A map field is written as repeated entries of key and value.
      if (stack.at(-1) === "Entry") {
        if (key !== "key" && key !== "value") undeclared.push(`Entry.${key}`);
        if (line.endsWith("{")) stack.push("Entry");
        continue;
      }
      const type = messages.get(stack.at(-1)!)?.get(key);
      if (type === undefined) undeclared.push(`${stack.at(-1)}.${key}`);
      if (line.endsWith("{")) stack.push(type?.startsWith("map<") ? "Entry" : (type ?? "?"));
    }
    expect(undeclared).toEqual([]);
  });
});
