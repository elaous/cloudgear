import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CacheOptions } from "@cloudgear/cache";
import { CACHE_FIELDS } from "../packages/cache/schema.gen";
import type { NetworkOptions } from "@cloudgear/network";
import { NETWORK_FIELDS } from "@cloudgear/network";
import { generate } from "../scripts/gen-schema";
import type { DnsOptions } from "@cloudgear/dns";
import { DNS_FIELDS } from "@cloudgear/dns";
import type { CertOptions } from "@cloudgear/cdn";
import { CERT_FIELDS } from "@cloudgear/cdn";
import type { SecretStoreOptions } from "@cloudgear/secrets";
import { SECRET_STORE_FIELDS } from "@cloudgear/secrets";

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

  // Fields that are not options: the provider, the name and positional arguments.
  test("Dns and Cert options name the same fields as the schema", () => {
    const dns: Required<Omit<DnsOptions, "driver">> = { zone: "", token: "" };
    expect(Object.keys(dns).sort()).toEqual(DNS_FIELDS.filter((f) => !["provider", "name", "domain"].includes(f)).sort());
    const cert: Required<Omit<CertOptions, "driver">> = { region: "", options: {} };
    expect(Object.keys(cert).sort()).toEqual(CERT_FIELDS.filter((f) => !["provider", "name", "dns"].includes(f)).sort());
  });

  test("SecretStore options name the same fields as the schema", () => {
    const store: Required<Omit<SecretStoreOptions, "driver">> = { service: "ssm", region: "", kmsKey: "" };
    expect(Object.keys(store).sort()).toEqual(SECRET_STORE_FIELDS.filter((f) => !["provider", "name"].includes(f)).map(camel).sort());
  });
});
