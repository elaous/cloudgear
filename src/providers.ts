import type { BlobAccess } from "@cloudgear/blob";
import type { CloudgearConfig } from "./config/schema";

type OptionRule = (value: string) => string | undefined;

export interface OptionSchema {
  keys: Record<string, OptionRule>;
  prefixes?: Record<string, OptionRule>;
}

export interface ProviderProfile {
  options: Record<string, OptionSchema>;
  reservedEnv: RegExp;
  function: { type: string; runtime: string; memoryMb: number; timeoutS: number; identity: "role" | "service-account" };
  blobStore: { type: string; actions: Record<BlobAccess, string[]> };
  cdn?: { type: string; certificate: string };
  api?: { type: string };
  schedule?: { type: string };
  events?: { type: string; rule: string };
  registry?: { type: string };
  stream?: { type: string };
  cache?: { type: string };
  instance?: { type: string };
}

const oneOf =
  (...allowed: string[]): OptionRule =>
  (value) =>
    allowed.includes(value) ? undefined : `must be one of ${allowed.join(", ")}`;

const integerBetween =
  (min: number, max: number): OptionRule =>
  (value) =>
    /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max ? undefined : `must be an integer from ${min} to ${max}`;

const idList =
  (pattern: RegExp, max: number, label: string): OptionRule =>
  (value) => {
    const ids = value.split(",");
    if (ids.length > max) return `accepts at most ${max} ${label} ids`;
    return ids.every((id) => pattern.test(id)) && new Set(ids).size === ids.length ? undefined : `must be a comma-separated list of distinct ${label} ids`;
  };

const NETWORK_RULES: Record<string, OptionRule> = {
  vpc: (v) => (v === "default" || /^vpc-[0-9a-f]{8,17}$/.test(v) ? undefined : 'must be "default" or a VPC id such as "vpc-0123456789abcdef0"'),
  subnets: idList(/^subnet-[0-9a-f]{8,17}$/, 16, "subnet"),
  security_groups: idList(/^sg-[0-9a-f]{8,17}$/, 5, "security group"),
};

const environmentVariable: OptionRule = (value) =>
  value.length <= 4096 ? undefined : "must be at most 4096 characters";

export const ENV_OPTION_PREFIX = "env.";

// A WAFv2 web ACL for CloudFront lives in us-east-1 under the global scope.
export const WEB_ACL_ARN = /^arn:aws:wafv2:us-east-1:\d{12}:global\/webacl\/[\w-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const PROVIDERS: Record<string, ProviderProfile> = {
  aws: {
    options: {
      "@aws.S3": { keys: { versioning: oneOf("true", "false") } },
      "@aws.Lambda": {
        keys: {
          tracing: oneOf("Active", "PassThrough"),
          ephemeral_storage_mb: integerBetween(512, 10240),
          ...NETWORK_RULES,
        },
        prefixes: { [ENV_OPTION_PREFIX]: environmentVariable },
      },
      "@aws.CloudFront": {
        keys: { price_class: oneOf("PriceClass_100", "PriceClass_200", "PriceClass_All"), web_acl: (v) => (v === "true" || WEB_ACL_ARN.test(v) ? undefined : "must be true (keep the web ACL the distribution has) or a WAFv2 web ACL ARN in us-east-1 (arn:aws:wafv2:us-east-1:<account>:global/webacl/<name>/<id>); only the aws partition is supported"), default_root_object: (v) => (/^(?!\/)(?!.*\.\.)[\w.\-/]*$/.test(v) ? undefined : "must be a relative object key") },
      },
      "@aws.ECR": {
        keys: {
          scan_on_push: oneOf("true", "false"),
          immutable_tags: oneOf("true", "false"),
          keep_untagged_days: (v) => (v === "off" || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 365) ? undefined : 'must be an integer from 1 to 365, or "off"'),
          allow_destroy: oneOf("true"),
        },
      },
      "@aws.ElastiCache": {
        keys: {
          engine: oneOf("valkey", "redis", "memcached"),
          size: oneOf("micro", "small", "medium"),
          allow_destroy: oneOf("true"),
          ...NETWORK_RULES,
        },
      },
      "@aws.EC2": {
        keys: {
          size: oneOf("micro", "small", "medium"),
          image: (v) => (/^ami-[0-9a-f]{8,17}$/.test(v) ? undefined : 'must be an AMI id such as "ami-0123456789abcdef0"'),
          disk_gb: integerBetween(1, 16384),
          key_name: (v) => (/^[\x20-\x7E]{1,255}$/.test(v) ? undefined : "must be a key pair name"),
          profile: (v) => (/^[\w+=,.@-]{1,128}$/.test(v) ? undefined : "must be an instance profile name"),
          user_data: (v) => (new TextEncoder().encode(v).length <= 16384 ? undefined : "must be at most 16384 bytes"),
          allow_destroy: oneOf("true"),
          ...NETWORK_RULES,
        },
      },
      "@aws.Kinesis": {
        keys: {
          mode: oneOf("provisioned", "on-demand"),
          shards: integerBetween(1, 10000),
          retention_hours: integerBetween(24, 8760),
          allow_destroy: oneOf("true"),
        },
      },
      "@aws.Certificate": { keys: { key_algorithm: oneOf("RSA_2048", "EC_prime256v1", "EC_secp384r1") } },
    },
    reservedEnv: /^(AWS_|CLOUDGEAR_|LAMBDA_|NODE_OPTIONS$|_)/,
    function: { type: "@aws.Lambda", runtime: "nodejs22.x", memoryMb: 256, timeoutS: 10, identity: "role" },
    cdn: { type: "@aws.CloudFront", certificate: "@aws.Certificate" },
    api: { type: "@aws.ApiGateway" },
    schedule: { type: "@aws.Schedule" },
    events: { type: "@aws.EventBus", rule: "@aws.EventRule" },
    registry: { type: "@aws.ECR" },
    stream: { type: "@aws.Kinesis" },
    cache: { type: "@aws.ElastiCache" },
    instance: { type: "@aws.EC2" },
    blobStore: {
      type: "@aws.S3",
      actions: {
        // ListBucket makes S3 answer 404, not 403, for missing keys.
        read: ["s3:GetObject", "s3:ListBucket"],
        write: ["s3:PutObject"],
        delete: ["s3:DeleteObject"],
        list: ["s3:ListBucket"],
      },
    },
  },
  gcp: {
    options: {
      "@gcp.GCS": {
        keys: {
          versioning: oneOf("true", "false"),
          project: (v) => (/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(v) ? undefined : 'must be a GCP project id such as "my-project-123"'),
          location: (v) => (/^[A-Za-z][A-Za-z0-9-]{1,30}$/.test(v) ? undefined : 'must be a bucket location such as "US" or "us-central1"'),
          storage_class: oneOf("STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"),
        },
      },
      "@gcp.CloudFunction": {
        keys: {
          project: (v) => (/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(v) ? undefined : 'must be a GCP project id such as "my-project-123"'),
          max_instances: integerBetween(1, 1000),
        },
        prefixes: { [ENV_OPTION_PREFIX]: environmentVariable },
      },
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

export function providerOfType(type: string): string {
  const match = /^@([a-z0-9]+)\./.exec(type);
  if (!match) throw new Error(`Resource type "${type}" does not name a provider (expected "@<provider>.<Service>")`);
  return match[1]!;
}

export function profileOfType(type: string): ProviderProfile {
  return providerProfile(providerOfType(type));
}

export function capability<K extends "cdn" | "api" | "schedule" | "events" | "registry" | "stream" | "cache" | "instance">(provider: string, name: K): NonNullable<ProviderProfile[K]> {
  const found = providerProfile(provider)[name];
  if (!found) throw new Error(`Provider "${provider}" does not support ${name === "cdn" ? "a CDN" : name === "api" ? "an API domain" : name === "events" ? "an event bus" : name === "registry" ? "an image registry" : name === "stream" ? "a stream" : name === "cache" ? "a cache" : name === "instance" ? "an instance" : "schedules"} yet`);
  return found as NonNullable<ProviderProfile[K]>;
}

export interface CrossProviderAccess {
  describe: string;
}

export const CROSS_PROVIDER_ACCESS: Record<string, CrossProviderAccess> = {};

export function crossProviderAccess(functionProvider: string, storeProvider: string): CrossProviderAccess | undefined {
  return CROSS_PROVIDER_ACCESS[`${functionProvider}->${storeProvider}`];
}

export const isBlobType = (type: string): boolean => Object.values(PROVIDERS).some((p) => p.blobStore.type === type);

export function providerProfile(provider: string): ProviderProfile {
  const profile = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : undefined;
  if (!profile) {
    throw new Error(`Provider "${provider}" is not supported yet (supported: ${Object.keys(PROVIDERS).join(", ")})`);
  }
  return profile;
}

// Services that run beside the cloud the functions deploy to.
export const SERVICES: Record<string, { options: Record<string, OptionSchema> }> = {
  neon: {
    options: {
      "@neon.Database": {
        keys: {
          region: (v) => (/^(aws|azure)-[a-z0-9]+(-[a-z0-9]+)+$/.test(v) ? undefined : 'must be a Neon region id such as "aws-us-east-1"'),
          pg_version: oneOf("14", "15", "16", "17"),
          allow_destroy: oneOf("true"),
        },
      },
    },
  },
};

export function validateOptions(provider: string, type: string, options: Record<string, string> | undefined, label: string): void {
  const service = Object.hasOwn(SERVICES, provider) ? SERVICES[provider] : undefined;
  for (const [key, value] of Object.entries(options ?? {})) {
    const schema = (service ?? providerProfile(provider)).options[type];
    const reserved = service ? /^$/ : providerProfile(provider).reservedEnv;
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
  for (const resource of config.resource) {
    check(resource.type, resource.name, resource.options);
    if (resource.type === "@aws.Kinesis" && resource.options?.mode === "on-demand" && resource.options.shards !== undefined) {
      throw new Error(`${resource.type} "${resource.name}": shards only applies to provisioned mode`);
    }
  }
  for (const fn of config.function) {
    check(fn.type, fn.name, fn.options);
    if (!fn.options?.vpc && (fn.options?.subnets || fn.options?.security_groups)) {
      throw new Error(`${fn.type} "${fn.name}": subnets and security_groups need a vpc`);
    }
  }
  for (const certificate of config.certificate) check(capability(certificate.provider, "cdn").certificate, certificate.domain, certificate.options);
  for (const cdn of config.cdn) check(capability(cdn.provider, "cdn").type, cdn.domain, cdn.options);
  if (config.api?.via === "cloudfront") check(capability(config.api.provider, "cdn").type, config.api.domain, config.api.options);
}
