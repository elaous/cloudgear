export type SecretProvider = "aws";
export type SecretService = "ssm" | "secretsmanager";

export interface SecretDriver {
  // Missing secrets are null, never an error.
  get(name: string): Promise<string | null>;
  getMany(names: string[]): Promise<Record<string, string>>;
  // Every secret directly under the prefix, with its value.
  list(prefix: string): Promise<Record<string, string>>;
  // The names under the prefix, without reading any value.
  names(prefix: string): Promise<string[]>;
  put(name: string, value: string): Promise<void>;
}

export interface SecretDriverOptions {
  service?: SecretService;
  region?: string;
  kmsKey?: string;
}

export type SecretDriverFactory = (options: SecretDriverOptions) => SecretDriver | Promise<SecretDriver>;

export const DEFAULT_SERVICE: SecretService = "ssm";

const factories = new Map<string, SecretDriverFactory>();

const BUILT_IN: Record<string, () => Promise<SecretDriverFactory>> = {
  "aws/ssm": async () => (await import("./drivers/ssm")).createSsmDriver,
  "aws/secretsmanager": async () => (await import("./drivers/secretsmanager")).createSecretsManagerDriver,
};

export function registerSecretDriver(provider: SecretProvider, service: string, factory: SecretDriverFactory): void {
  factories.set(`${provider}/${service}`, factory);
}

export async function createSecretDriver(provider: SecretProvider, options: SecretDriverOptions = {}): Promise<SecretDriver> {
  if (process.env.CLOUDGEAR_SECRETS_DRIVER === "memory") return (await import("./drivers/memory")).createMemorySecretDriver();
  const key = `${provider}/${options.service ?? DEFAULT_SERVICE}`;
  let factory = factories.get(key);
  if (!factory) {
    const load = BUILT_IN[key];
    if (!load) throw new Error(`No secret driver for "${key}"; register one with registerSecretDriver()`);
    factory = await load();
    factories.set(key, factory);
  }
  return factory(options);
}

const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const MAX_DEPTH = 15;

// "/cloudgear/app" or "/cloudgear/app/*"; the wildcard asks for every secret under the path.
export function parseSecretPath(path: string): { prefix: string; all: boolean } {
  const all = path.endsWith("/*");
  const prefix = (all ? path.slice(0, -2) : path).replace(/\/+$/, "");
  const segments = prefix.split("/").slice(1);
  if (!prefix.startsWith("/") || !segments.length || segments.length > MAX_DEPTH - 1 || segments.some((s) => !PATH_SEGMENT.test(s))) {
    throw new Error(`Invalid secret path "${path}": expected "/segment/segment" using letters, digits, "_", "." and "-"`);
  }
  return { prefix, all };
}

const NAME = /^[A-Za-z0-9_.-]+$/;

export function assertSecretName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Invalid secret name "${name}": use letters, digits, "_", "." and "-"`);
  return name;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertEnvName(name: string): string {
  if (!ENV_NAME.test(name)) throw new Error(`Invalid environment variable name "${name}"`);
  return name;
}
