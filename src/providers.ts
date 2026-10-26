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
  // Environment variable names the platform owns.
  reservedEnv: RegExp;
  // How a function is identified when it calls other services.
  function: { type: string; runtime: string; memoryMb: number; timeoutS: number; identity: "role" | "service-account" };
  blobStore: { type: string; actions: Record<BlobAccess, string[]> };
  cdn?: { type: string; certificate: string };
  api?: { type: string };
  schedule?: { type: string };
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
        keys: { price_class: oneOf("PriceClass_100", "PriceClass_200", "PriceClass_All"), default_root_object: (v) => (/^(?!\/)(?!.*\.\.)[\w.\-/]*$/.test(v) ? undefined : "must be a relative object key") },
      },
      "@aws.Certificate": { keys: { key_algorithm: oneOf("RSA_2048", "EC_prime256v1", "EC_secp384r1") } },
    },
    reservedEnv: /^(AWS_|CLOUDGEAR_|LAMBDA_|NODE_OPTIONS$|_)/,
    function: { type: "@aws.Lambda", runtime: "nodejs22.x", memoryMb: 256, timeoutS: 10, identity: "role" },
    cdn: { type: "@aws.CloudFront", certificate: "@aws.Certificate" },
    api: { type: "@aws.ApiGateway" },
    schedule: { type: "@aws.Schedule" },
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
  // Describes how a GCP app is written to the config; there are no GCP deployers yet.
  gcp: {
    options: {
      "@gcp.GCS": { keys: { versioning: oneOf("true", "false") } },
      "@gcp.CloudFunction": { keys: {}, prefixes: { [ENV_OPTION_PREFIX]: environmentVariable } },
    },
    reservedEnv: /^(CLOUDGEAR_|FUNCTION_|K_|GOOGLE_|GCP_|NODE_OPTIONS$|_)/,
    function: { type: "@gcp.CloudFunction", runtime: "nodejs22", memoryMb: 256, timeoutS: 60, identity: "service-account" },
    blobStore: {
      type: "@gcp.GCS",
      actions: {
        read: ["storage.objects.get"],
        write: ["storage.objects.create"],
        delete: ["storage.objects.delete"],
        list: ["storage.objects.list"],
      },
    },
  },
};

// The provider a resource type belongs to: "@aws.S3" is "aws".
export function providerOfType(type: string): string {
  const match = /^@([a-z0-9]+)\./.exec(type);
  if (!match) throw new Error(`Resource type "${type}" does not name a provider (expected "@<provider>.<Service>")`);
  return match[1]!;
}

export function profileOfType(type: string): ProviderProfile {
  return providerProfile(providerOfType(type));
}

export function capability<K extends "cdn" | "api" | "schedule">(provider: string, name: K): NonNullable<ProviderProfile[K]> {
  const found = providerProfile(provider)[name];
  if (!found) throw new Error(`Provider "${provider}" does not support ${name === "cdn" ? "a CDN" : name === "api" ? "an API domain" : "schedules"} yet`);
  return found as NonNullable<ProviderProfile[K]>;
}

// A function reaching a store of another provider needs credentials for it. Each mechanism
// (a key, workload identity federation, a signed URL) registers under "<function provider>-><store provider>".
export interface CrossProviderAccess {
  describe: string;
}

export const CROSS_PROVIDER_ACCESS: Record<string, CrossProviderAccess> = {};

export function crossProviderAccess(functionProvider: string, storeProvider: string): CrossProviderAccess | undefined {
  return CROSS_PROVIDER_ACCESS[`${functionProvider}->${storeProvider}`];
}

export function providerProfile(provider: string): ProviderProfile {
  const profile = PROVIDERS[provider];
  if (!profile) {
    throw new Error(`Provider "${provider}" is not supported yet (supported: ${Object.keys(PROVIDERS).join(", ")})`);
  }
  return profile;
}

export function validateOptions(provider: string, type: string, options: Record<string, string> | undefined, label: string): void {
  for (const [key, value] of Object.entries(options ?? {})) {
    const schema = providerProfile(provider).options[type];
    const reserved = providerProfile(provider).reservedEnv;
    const prefix = Object.keys(schema?.prefixes ?? {}).find((p) => key.startsWith(p));
    const rule = (schema && Object.hasOwn(schema.keys, key) ? schema.keys[key] : undefined) ?? (prefix ? schema!.prefixes![prefix] : undefined);
    if (!rule) {
      const supported = [...Object.keys(schema?.keys ?? {}), ...Object.keys(schema?.prefixes ?? {}).map((p) => `${p}<NAME>`)];
      throw new Error(`${label}: unknown option "${key}" for ${type} (supported: ${supported.join(", ") || "none"})`);
    }
    const problem = rule(value);
    if (problem) throw new Error(`${label}: option "${key}" ${problem}`);
    if (prefix === ENV_OPTION_PREFIX) {
      const name = key.slice(prefix.length);
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || reserved.test(name)) {
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
    validateOptions(providerOfType(type), type, options, `${type} "${name}"`);
  for (const resource of config.resource) check(resource.type, resource.name, resource.options);
  for (const fn of config.function) check(fn.type, fn.name, fn.options);
  for (const certificate of config.certificate) check(capability(certificate.provider, "cdn").certificate, certificate.domain, certificate.options);
  if (config.cdn) check(capability(config.cdn.provider, "cdn").type, config.cdn.domain, config.cdn.options);
}
