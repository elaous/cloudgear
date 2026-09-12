// Bun.TOML only exposes `parse` (confirmed against the installed runtime --
// there is no `Bun.TOML.stringify`), so resources.toml is hand-serialized
// here rather than assumed. Deliberately minimal: this only ever writes
// resources.toml's own shape (nested tables of string values), not
// arbitrary TOML -- arrays, numbers, and dates are unsupported on purpose,
// since adding them without a real use would be untested guesswork.
export function stringifyToml(
  data: Record<string, unknown>,
  path: string[] = [],
): string {
  const scalarLines: string[] = [];
  const tableBlocks: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      tableBlocks.push(
        stringifyToml(value as Record<string, unknown>, [...path, key]),
      );
    } else if (typeof value === "string") {
      scalarLines.push(`${key} = ${JSON.stringify(value)}`);
    } else {
      throw new Error(
        `stringifyToml: unsupported value type for "${[...path, key].join(".")}" -- only strings and nested objects are handled`,
      );
    }
  }

  const header = path.length ? `[${path.join(".")}]\n` : "";
  const body = scalarLines.join("\n");
  const thisTable = header + body + (body ? "\n" : "");
  return [thisTable, ...tableBlocks].filter(Boolean).join("\n");
}
