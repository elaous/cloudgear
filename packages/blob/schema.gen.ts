// Generated from proto/ by scripts/gen-schema.ts; do not edit.

export const BLOB_PROVIDERS = ["aws","gcp","azure"] as const;

export const CORS_METHODS = ["GET","HEAD","POST","PUT","DELETE"] as const;

export const BLOB_STORE_FIELDS = ["provider","name","bucket","path","region","options"] as const;

export const BLOB_STORE_OPERATIONS = {
  get: ["read"],
  getText: ["read"],
  getJson: ["read"],
  exists: ["read","list"],
  put: ["write"],
  delete: ["delete"],
  list: ["list"],
} as const;

export const CORS_RULE_FIELDS = ["origins","methods","headers","expose_headers","max_age_seconds"] as const;

export const CACHE_CONTROL_RULE_FIELDS = ["match","value"] as const;

export const SITE_FILES_FIELDS = ["dir","include","exclude","prune","cache_control"] as const;

export const BLOB_STORE_WEB_SITE_FIELDS = ["provider","name","bucket","path","region","options","index_document","error_document","files","cors"] as const;

export const BLOB_STORE_WEB_SITE_DEFAULTS = {
  indexDocument: "index.html",
} as const;
