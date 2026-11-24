import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CacheOptions } from "@cloudgear/cache";
import { CACHE_FIELDS } from "../packages/cache/schema.gen";
import type { NetworkOptions } from "@cloudgear/network";
import { NETWORK_FIELDS } from "@cloudgear/network";
import { generate } from "../scripts/gen-schema";

const camel = (name: string): string => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe("schema", () => {
  test("generated constants match the proto files", () => {
    for (const [target, content] of generate()) {
      expect(readFileSync(join(import.meta.dir, "..", target), "utf8")).toBe(content);
    }
  });

  // Required<> makes the compiler list every option; the schema must name the same ones.
  test("hand-written option types name the same fields as the schema", () => {
    const network: Required<NetworkOptions> = { vpc: "", subnets: [], securityGroups: [] };
    expect(Object.keys(network).sort()).toEqual(NETWORK_FIELDS.map(camel).sort());
    const cache: Required<CacheOptions> = { engine: "valkey", size: "micro", network: { provider: "aws" }, allowDestroy: false };
    expect(Object.keys(cache).sort()).toEqual(CACHE_FIELDS.filter((f) => f !== "provider" && f !== "name").map(camel).sort());
  });
});
