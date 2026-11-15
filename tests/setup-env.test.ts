import { describe, expect, test } from "bun:test";
import path from "node:path";
import { analyzeApp } from "../src/analyze/app";

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", name);

describe("setup.ts environment variables", () => {
  test("domain, zone and bucket come from the environment", () => {
    const model = analyzeApp(fixture("env-domain.ts"), { ENV_DOMAIN: "staging.example.com", ENV_ZONE: "example.com" });

    expect(model.certificates.map((c) => ({ domain: c.domain, zone: c.dns.zone }))).toEqual([{ domain: "web.staging.example.com", zone: "example.com" }]);
    expect(model.cdns.map((c) => ({ domain: c.domain, bucket: c.bucket }))).toEqual([{ domain: "web.staging.example.com", bucket: "web.staging.example.com" }]);
  });

  test("?? supplies a default only when the variable is unset", () => {
    const unset = analyzeApp(fixture("env-domain.ts"), { ENV_DOMAIN: "example.com" });
    expect(unset.certificates[0]!.dns.zone).toBe("example.com");

    const empty = analyzeApp(fixture("env-domain.ts"), { ENV_DOMAIN: "example.com", ENV_ZONE: "" });
    expect(empty.certificates[0]!.dns.zone).toBe("example.com");
  });

  test("a missing variable names the variable and the location", () => {
    expect(() => analyzeApp(fixture("env-domain.ts"), {})).toThrow(/env-domain\.ts:\d+.*environment variable ENV_DOMAIN is not set/);
  });

  test("a value that cannot be known statically is rejected", () => {
    expect(() => analyzeApp(fixture("env-domain-dynamic.ts"), {})).toThrow(/DNS domain must be a string literal or an environment variable/);
  });
});
