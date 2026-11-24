// Generated from proto/ by scripts/gen-schema.ts; do not edit.

export const CACHE_PROVIDERS = ["aws"] as const;

export const CACHE_ENGINES = ["valkey","redis","memcached"] as const;

export const CACHE_SIZES = ["micro","small","medium"] as const;

export const CACHE_DEFAULTS = {
  engine: "valkey",
  size: "micro",
} as const;
