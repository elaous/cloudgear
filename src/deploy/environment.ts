import type { DriverContext } from "./apply";
import { OUTPUT_REFERENCE } from "./plan";

// Fills in the values that point at another resource's output; without a context they stay as written.
export function resolveOutputReferences(env: Record<string, string>, context?: DriverContext): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      if (!context || !value.startsWith(OUTPUT_REFERENCE)) return [key, value];
      const at = value.lastIndexOf("#");
      const stateEntry = value.slice(OUTPUT_REFERENCE.length, at);
      const found = context.entry(stateEntry)?.outputs[value.slice(at + 1)];
      if (found === undefined || found === "") throw new Error(`${stateEntry} has no ${value.slice(at + 1)} yet, so ${key} cannot be set; apply it first`);
      return [key, found];
    }),
  );
}
