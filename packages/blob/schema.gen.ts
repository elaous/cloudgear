// Generated from proto/ by scripts/gen-schema.ts; do not edit.

export const BLOB_PROVIDERS = ["aws","gcp","azure"] as const;

export const BLOB_STORE_FIELDS = ["provider","name","path","region","options"] as const;

export const BLOB_STORE_OPERATIONS = {
  get: ["read"],
  getText: ["read"],
  getJson: ["read"],
  exists: ["read","list"],
  put: ["write"],
  delete: ["delete"],
  list: ["list"],
} as const;
