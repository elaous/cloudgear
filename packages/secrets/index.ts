import { debug, timed } from "@cloudgear/debug";
import {
  assertEnvName,
  assertSecretName,
  createSecretDriver,
  DEFAULT_SERVICE,
  parseSecretPath,
  type SecretDriver,
  type SecretDriverFactory,
  type SecretProvider,
  type SecretService,
} from "./driver";

export { createSecretDriver, registerSecretDriver, parseSecretPath } from "./driver";
export type { SecretDriver, SecretDriverFactory, SecretDriverOptions, SecretProvider, SecretService } from "./driver";

export interface SecretStoreOptions {
  // "ssm" (Parameter Store, the default) or "secretsmanager". Literal only.
  service?: SecretService;
  // Region of the store; defaults to the function's. Literal only.
  region?: string;
  // Key id or ARN encrypting what `secrets set` writes. Literal only.
  kmsKey?: string;
  driver?: SecretDriver;
}

// What a function reads: environment variable name -> secret name under the path.
export interface EnvBinding {
  readonly kind: "env";
  readonly store: SecretStore;
  readonly prefix: string;
  readonly names: Readonly<Record<string, string>>;
}

export interface SecretPath {
  (names: readonly string[] | Readonly<Record<string, string>>): EnvBinding;
  (name: string): SecretRef;
  readonly store: SecretStore;
  readonly prefix: string;
  // The path ended in "/*": every secret under it.
  readonly all: boolean;
}

// Constructing it does nothing; `cloudgear apply` grants functions what they declare.
export class SecretStore {
  private driverPromise?: Promise<SecretDriver>;

  constructor(
    readonly provider: SecretProvider,
    readonly options: SecretStoreOptions = {},
  ) {
    if (provider !== "aws") throw new Error(`Secret provider "${provider}" is not supported yet (supported: aws)`);
    if (options.driver) this.driverPromise = Promise.resolve(options.driver);
  }

  get service(): SecretService {
    return this.options.service ?? DEFAULT_SERVICE;
  }

  path(path: string): SecretPath {
    const { prefix, all } = parseSecretPath(path);
    const bound = ((arg: string | readonly string[] | Readonly<Record<string, string>>) => {
      if (typeof arg === "string") return new SecretRef(this, prefix, arg);
      const names: Record<string, string> = {};
      const entries = Array.isArray(arg) ? arg.map((name): [string, string] => [name, name]) : Object.entries(arg as Record<string, string>);
      for (const [envName, name] of entries) names[assertEnvName(envName)] = assertSecretName(name);
      return Object.freeze({ kind: "env" as const, store: this, prefix, names: Object.freeze(names) });
    }) as SecretPath;
    return Object.defineProperties(bound, {
      store: { value: this },
      prefix: { value: prefix },
      all: { value: all },
    });
  }

  driver(): Promise<SecretDriver> {
    this.driverPromise ??= createSecretDriver(this.provider, this.options).catch((err) => {
      this.driverPromise = undefined;
      throw err;
    });
    return this.driverPromise;
  }
}

// One secret. A plain object: awaiting it does nothing, call get().
export class SecretRef {
  readonly name: string;

  constructor(
    readonly store: SecretStore,
    readonly prefix: string,
    name: string,
  ) {
    this.name = assertSecretName(name);
  }

  get fullName(): string {
    return `${this.prefix}/${this.name}`;
  }

  // The environment variable of that name first (a deployed function has its secrets there, a local run its .env),
  // then the store.
  async get(): Promise<string> {
    const local = process.env[this.name];
    if (local !== undefined) return local;
    const value = await timed("secrets", `get ${this.fullName}`, async () => (await this.store.driver()).get(this.fullName));
    if (value === null) throw new Error(`Secret ${this.fullName} was not found; set it with \`cloudgear secrets set\``);
    return value;
  }
}

export interface SecretBindingSpec {
  provider: SecretProvider;
  service: SecretService;
  region?: string;
  path: string;
  // Empty for a wildcard binding, which reads everything under `path`.
  name: string;
  env: string;
  all?: boolean;
}

// Puts the declared secrets in `process.env` without overwriting what is already there, once per process.
export function secretsLoader(bindings: readonly SecretBindingSpec[], factories: Partial<Record<SecretService, SecretDriverFactory>> = {}): () => Promise<void> {
  let loading: Promise<void> | undefined;
  return () => (loading ??= hydrate(bindings, factories).catch((err) => {
    loading = undefined;
    throw err;
  }));
}

async function hydrate(bindings: readonly SecretBindingSpec[], factories: Partial<Record<SecretService, SecretDriverFactory>>): Promise<void> {
  const groups = new Map<string, SecretBindingSpec[]>();
  for (const binding of bindings) {
    const key = `${binding.provider}/${binding.service}/${binding.region ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), binding]);
  }
  const missing: string[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const factory = factories[first.service];
    const driver = factory ? await factory({ service: first.service, region: first.region }) : await createSecretDriver(first.provider, { service: first.service, region: first.region });
    const wanted = group.filter((b) => !b.all && process.env[b.env] === undefined);
    const found = wanted.length ? await driver.getMany([...new Set(wanted.map((b) => `${b.path}/${b.name}`))]) : {};
    for (const binding of wanted) {
      const value = found[`${binding.path}/${binding.name}`];
      if (value === undefined) missing.push(`${binding.path}/${binding.name}`);
      else process.env[binding.env] = value;
    }
    for (const path of new Set(group.filter((b) => b.all).map((b) => b.path))) {
      for (const [name, value] of Object.entries(await driver.list(path))) {
        const env = name.slice(path.length + 1);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(env) && process.env[env] === undefined) process.env[env] = value;
      }
    }
  }
  debug("secrets", "loaded", () => ({ bindings: bindings.length, missing: missing.length }));
  if (missing.length) throw new Error(`Secrets not found: ${missing.join(", ")}; set them with \`cloudgear secrets set\``);
}
