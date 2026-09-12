import { describe, expect, test } from "bun:test";
import { stringifyToml } from "../toml";

describe("stringifyToml", () => {
  test("serializes a flat table of string scalars", () => {
    const out = stringifyToml({ url: "PENDING_PROVISION", name: "items" });
    expect(out).toBe('url = "PENDING_PROVISION"\nname = "items"\n');
  });

  test("serializes nested tables with dotted headers", () => {
    const out = stringifyToml({
      aws: { DynamoTable: { items: { url: "PENDING_PROVISION" } } },
    });
    expect(out).toBe(
      "[aws]\n\n[aws.DynamoTable]\n\n[aws.DynamoTable.items]\nurl = \"PENDING_PROVISION\"\n",
    );
  });

  test("escapes strings with embedded quotes via JSON.stringify", () => {
    const out = stringifyToml({ note: 'has "quotes" in it' });
    expect(out).toBe('note = "has \\"quotes\\" in it"\n');
  });

  test("returns an empty string for an empty object", () => {
    expect(stringifyToml({})).toBe("");
  });

  test("throws on unsupported value types", () => {
    expect(() => stringifyToml({ count: 1 } as unknown as Record<string, unknown>)).toThrow(
      /unsupported value type for "count"/,
    );
  });

  test("throws on array values", () => {
    expect(() =>
      stringifyToml({ items: ["a", "b"] } as unknown as Record<string, unknown>),
    ).toThrow(/unsupported value type for "items"/);
  });

  test("includes the full dotted path in the error for nested tables", () => {
    expect(() =>
      stringifyToml({ aws: { count: 1 } } as unknown as Record<string, unknown>),
    ).toThrow(/unsupported value type for "aws\.count"/);
  });
});
