import type { BlobAccess } from "@cloudgear/blob";
import type { CloudgearConfig } from "./config/schema";

type OptionRule = (value: string) => string | undefined;

export interface OptionSchema {
  keys: Record<string, OptionRule>;
  prefixes?: Record<string, OptionRule>;
}

// Per provider: the flagship service each cloudgear client is inferred as,
// and the permissions each client operation needs.
export interface ProviderProfile {
  options: Record<string, OptionSchema>;
  function: { type: string; runtime: string; memoryMb: number; timeoutS: number };
  blobStore: { type: string; actions: Record<BlobAccess, string[]> };
  cdn: { type: string; certificate: string };
}

const oneOf =
  (...allowed: string[]): OptionRule =>
  (value) =>
    allowed.includes(value) ? undefined : `must be one of ${allowed.join(", ")}`;

const integerBetween =
  (min: number, max: number): OptionRule =>
  (value) =>
    /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max ? undefined : `must be an integer from ${min} to ${max}`;

const environmentVariable: OptionRule = (value) =>
  value.length <= 4096 ? undefined : "must be at most 4096 characters";

export const ENV_OPTION_PREFIX = "env.";

export const PROVIDERS: Record<string, ProviderProfile> = {
  aws: {
    options: {
      "@aws.S3": { keys: { versioning: oneOf("true", "false") } },
      "@aws.Lambda": {
        keys: { tracing: oneOf("Active", "PassThrough"), ephemeral_storage_mb: integerBetween(512, 10240) },
        prefixes: { [ENV_OPTION_PREFIX]: environmentVariable },
      },
      "@aws.CloudFront": {
        keys: { price_class: oneOf("PriceClass_100", "PriceClass_200", "PriceClass_All"), default_root_object: (v) => (/^[\w.\-/]*$/.test(v) ? undefined : "must be a plain object key") },
      },
      "@aws.Certificate": { keys: { key_algorithm: oneOf("RSA_2048", "EC_prime256v1", "EC_secp384r1") } },
    },
    function: { type: "@aws.Lambda", runtime: "nodejs22.x", memoryMb: 256, timeoutS: 10 },
    cdn: { type: "@aws.CloudFront", certificate: "@aws.Certificate" },
    blobStore: {
      type: "@aws.S3",
      actions: {
        // ListBucket makes S3 answer 404 instead of 403 for a missing key.
        read: ["s3:GetObject", "s3:ListBucket"],
        write: ["s3:PutObject"],
        delete: ["s3:DeleteObject"],
        list: ["s3:ListBucket"],
      },
    },
  },
};

export function providerProfile(provider: string): ProviderProfile {
  const profile = PROVIDERS[provider];
  if (!profile) {
    throw new Error(`Provider "${provider}" is not supported yet (supported: ${Object.keys(PROVIDERS).join(", ")})`);
  }
  return profile;
}

const RESERVED_ENV = /^(AWS_|CLOUDGEAR_|NODE_OPTIONS$|_)/;

export function validateOptions(provider: string, type: string, options: Record<string, string> | undefined, label: string): void {
  for (const [key, value] of Object.entries(options ?? {})) {
    const schema = providerProfile(provider).options[type];
    const prefix = Object.keys(schema?.prefixes ?? {}).find((p) => key.startsWith(p));
    const rule = schema?.keys[key] ?? (prefix ? schema!.prefixes![prefix] : undefined);
    if (!rule) {
      const supported = [...Object.keys(schema?.keys ?? {}), ...Object.keys(schema?.prefixes ?? {}).map((p) => `${p}<NAME>`)];
      throw new Error(`${label}: unknown option "${key}" for ${type} (supported: ${supported.join(", ") || "none"})`);
    }
    const problem = rule(value);
    if (problem) throw new Error(`${label}: option "${key}" ${problem}`);
    if (prefix === ENV_OPTION_PREFIX) {
      const name = key.slice(prefix.length);
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || RESERVED_ENV.test(name)) {
        throw new Error(`${label}: option "${key}" is not a usable environment variable name`);
      }
    }
  }
}

export function environmentOptions(options: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(options ?? {})
      .filter(([key]) => key.startsWith(ENV_OPTION_PREFIX))
      .map(([key, value]) => [key.slice(ENV_OPTION_PREFIX.length), value]),
  );
}

export function validateConfigOptions(config: CloudgearConfig): void {
  const check = (type: string, name: string, options?: Record<string, string>) =>
    validateOptions(config.provider, type, options, `${type} "${name}"`);
  for (const resource of config.resource) check(resource.type, resource.name, resource.options);
  for (const fn of config.function) check(fn.type, fn.name, fn.options);
  if (config.certificate) check(providerProfile(config.provider).cdn.certificate, config.certificate.domain, config.certificate.options);
  if (config.cdn) check(providerProfile(config.cdn.provider).cdn.type, config.cdn.domain, config.cdn.options);
}
