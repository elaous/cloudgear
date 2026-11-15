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

  test("?? supplies a default when the variable is unset or empty", () => {
    const unset = analyzeApp(fixture("env-domain.ts"), { ENV_DOMAIN: "example.com" });
    expect(unset.certificates[0]!.dns.zone).toBe("example.com");

    const empty = analyzeApp(fixture("env-domain.ts"), { ENV_DOMAIN: "example.com", ENV_ZONE: "" });
    expect(empty.certificates[0]!.dns.zone).toBe("example.com");
  });

  test("a missing variable names the variable and the location", () => {
    expect(() => analyzeApp(fixture("env-domain.ts"), {})).toThrow(/env-domain\.ts:\d+.*environment variable ENV_DOMAIN is unset or empty/);
  });

  test("a value that cannot be known statically is rejected", () => {
    expect(() => analyzeApp(fixture("env-domain-dynamic.ts"), {})).toThrow(/DNS domain must be a string literal or an environment variable/);
  });

  test("process.env, Bun.env, import.meta.env, wrappers, defaults, consts and shorthand all resolve", () => {
    const model = analyzeApp(fixture("env-forms.ts"), {
      D1: "one.example.com",
      D2: "two.example.com",
      D3: "three.example.com",
      D6: "six.example.com",
      D7: "zone.example.com",
      D9: "nine.example.com",
      BUCKET: "assets",
      PREFIX: "img",
    });

    expect(model.certificates.map((c) => c.domain).sort()).toEqual(
      ["a.one.example.com", "api.zone.example.com", "d4.example.com", "d5.example.com", "d8.example.com", "d9.nine.example.com", "six.example.com", "three.example.com", "two.example.com"].sort(),
    );
    expect(model.certificates.find((c) => c.domain === "api.zone.example.com")!.dns.zone).toBe("zone.example.com");
    expect(model.resources.map((r) => r.name)).toContain("bucket-assets");
    expect(model.region).toBe("us-east-1");
  });

  test("an unset variable in a concatenation names the variable", () => {
    expect(() => analyzeApp(fixture("env-forms.ts"), { D1: "one.example.com", D2: "two.example.com", D3: "three.example.com", D6: "six.example.com", D7: "zone.example.com", BUCKET: "x", PREFIX: "y" })).toThrow(/environment variable D9 is unset or empty/);
  });

  test("a default never hides a left side that cannot be analyzed", () => {
    expect(() => analyzeApp(fixture("env-domain-opaque-default.ts"), {})).toThrow(/DNS domain must be a string literal or an environment variable/);
  });
});
