// Generated from proto/ by scripts/gen-schema.ts; do not edit.

export const SECRET_PROVIDERS = ["aws"] as const;

export const SECRET_SERVICES = ["ssm","secretsmanager"] as const;

export const SECRET_STORE_FIELDS = ["provider","name","service","region","kms_key"] as const;

export const SECRET_STORE_DEFAULTS = {
  service: "ssm",
} as const;

export const SECRET_REF_FIELDS = ["store","path","secret"] as const;
