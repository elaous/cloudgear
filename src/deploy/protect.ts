import type { StateEntry } from "./state";

export const destroyAllowed = (current: StateEntry): boolean => ((current.spec.options ?? {}) as Record<string, string>).allow_destroy === "true";

// Adoption must not grant deletion; the next apply records allow_destroy.
export function withoutAllowDestroy(spec: Record<string, unknown>): Record<string, unknown> {
  const { allow_destroy: _ignored, ...options } = (spec.options ?? {}) as Record<string, string>;
  const { options: _before, ...rest } = spec;
  return Object.keys(options).length ? { ...rest, options } : rest;
}
