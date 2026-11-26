import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CacheOptions } from "@cloudgear/cache";
import { CACHE_FIELDS } from "../packages/cache/schema.gen";
import type { NetworkOptions } from "@cloudgear/network";
import { NETWORK_FIELDS } from "@cloudgear/network";
import { create, getOption, toBinary } from "@bufbuild/protobuf";
import { FieldOptionsSchema, type FieldOptions } from "@bufbuild/protobuf/wkt";
import { generate, loadRegistry } from "../scripts/gen-schema";
import type { DnsOptions } from "@cloudgear/dns";
import { DNS_FIELDS } from "@cloudgear/dns";
import type { CertOptions } from "@cloudgear/cdn";
import { CERT_FIELDS } from "@cloudgear/cdn";
import type { BlobStoreOptions } from "@cloudgear/blob";
import { BLOB_STORE_FIELDS, BLOB_STORE_WEB_SITE_FIELDS } from "@cloudgear/blob";
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

  // The bucket is the positional URI argument of BlobStore.
  test("BlobStore options name the same fields as the schema", () => {
    const store: Required<Omit<BlobStoreOptions, "driver">> = { path: "", region: "", options: {} };
    expect(Object.keys(store).sort()).toEqual(BLOB_STORE_FIELDS.filter((f) => !["provider", "name", "bucket"].includes(f)).sort());
  });

  // The web site repeats the parent's fields first.
  test("BlobStoreWebSite repeats the BlobStore fields exactly", () => {
    for (const field of BLOB_STORE_FIELDS) expect([...BLOB_STORE_WEB_SITE_FIELDS]).toContain(field);
    expect([...BLOB_STORE_WEB_SITE_FIELDS].slice(0, BLOB_STORE_FIELDS.length)).toEqual([...BLOB_STORE_FIELDS]);
    const registry = loadRegistry();
    const parent = registry.getMessage("cloudgear.v1.BlobStore")!;
    const child = registry.getMessage("cloudgear.v1.BlobStoreWebSite")!;
    const optionBytes = (field: { proto: { options?: FieldOptions } }): string =>
      Buffer.from(toBinary(FieldOptionsSchema, field.proto.options ?? create(FieldOptionsSchema))).toString("hex");
    for (const field of parent.fields) {
      const same = child.fields.find((f) => f.name === field.name)!;
      expect(same).toBeDefined();
      const shape = (f: typeof field) => [f.number, f.fieldKind, f.proto.type, f.fieldKind === "map" ? f.mapKind : f.proto.typeName, f.proto.label, f.proto.proto3Optional];
      expect(shape(same)).toEqual(shape(field));
      expect(optionBytes(same)).toBe(optionBytes(field));
    }
    expect(getOption(child, registry.getExtension("cloudgear.v1.extends")!)).toBe("BlobStore");
  });
});
