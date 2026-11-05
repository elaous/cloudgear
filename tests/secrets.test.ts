import { afterEach, describe, expect, test } from "bun:test";
import { SecretRef, SecretStore, createSecretDriver, parseSecretPath, registerSecretDriver, secretsLoader, type SecretBindingSpec, type SecretDriver } from "@cloudgear/secrets";
import { MemorySecretDriver } from "../packages/secrets/drivers/memory";
import { SecretsManagerDriver } from "../packages/secrets/drivers/secretsmanager";
import { SsmSecretDriver } from "../packages/secrets/drivers/ssm";

const memory = () => new MemorySecretDriver(new Map());
const named = (name: string, message = name) => Object.assign(new Error(message), { name });

afterEach(() => {
  for (const key of ["MY_ENV_1", "MY_ENV_2", "MY_ENV_3", "FROM_ENV", "ONLY_STORE", "OLD_NAME"]) delete process.env[key];
  delete process.env.CLOUDGEAR_SECRETS_DRIVER;
});

describe("paths and names", () => {
  test("a path is a prefix, optionally ending in /* for everything under it", () => {
    expect(parseSecretPath("/cloudgear/myproject")).toEqual({ prefix: "/cloudgear/myproject", all: false });
    expect(parseSecretPath("/cloudgear/myproject/")).toEqual({ prefix: "/cloudgear/myproject", all: false });
    expect(parseSecretPath("/cloudgear/myproject/*")).toEqual({ prefix: "/cloudgear/myproject", all: true });
  });

  test.each(["", "/", "cloudgear/app", "/a b", "/a//b", "/a/*/b", "/a/$x", "/*", `/${Array.from({ length: 15 }, () => "x").join("/")}`])("rejects %j", (path) => {
    expect(() => parseSecretPath(path)).toThrow(/Invalid secret path/);
  });
});

describe("SecretStore", () => {
  const store = new SecretStore("aws", { driver: memory() });

  test("path() gives a handle that declares env bindings and single secrets", () => {
    const env = store.path("/cloudgear/app");
    expect(env.prefix).toBe("/cloudgear/app");
    expect(env.all).toBe(false);
    const binding = env(["MY_ENV_1", "MY_ENV_2"]);
    expect(binding).toMatchObject({ kind: "env", prefix: "/cloudgear/app", names: { MY_ENV_1: "MY_ENV_1", MY_ENV_2: "MY_ENV_2" } });
    expect(binding.store).toBe(store);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.names)).toBe(true);
    const renamed = env({ DATABASE_URL: "db-url" });
    expect(renamed.names).toEqual({ DATABASE_URL: "db-url" });
    const ref = env("MY_ENV_3");
    expect(ref).toBeInstanceOf(SecretRef);
    expect(ref.fullName).toBe("/cloudgear/app/MY_ENV_3");
    expect(store.path("/cloudgear/app/*").all).toBe(true);
  });

  test("bad names and variables are refused up front", () => {
    const env = store.path("/cloudgear/app");
    expect(() => env(["has space"])).toThrow(/Invalid environment variable name/);
    expect(() => env({ OK: "has space" })).toThrow(/Invalid secret name/);
    expect(() => env({ "1BAD": "ok" })).toThrow(/Invalid environment variable name/);
    expect(() => env("a/b")).toThrow(/Invalid secret name/);
  });

  test("only AWS stores exist so far, with ssm as the default service", () => {
    expect(() => new SecretStore("gcp" as "aws")).toThrow(/not supported yet/);
    expect(store.service).toBe("ssm");
    expect(new SecretStore("aws", { service: "secretsmanager" }).service).toBe("secretsmanager");
  });

  test("a registered driver replaces the built-in one, and CLOUDGEAR_SECRETS_DRIVER=memory uses the memory driver", async () => {
    const base = memory();
    const custom: SecretDriver = { get: async () => "from-custom", getMany: (n) => base.getMany(n), list: (p) => base.list(p), names: (p) => base.names(p), put: (n, v) => base.put(n, v) };
    registerSecretDriver("aws", "ssm", () => custom);
    try {
      expect(await (await createSecretDriver("aws", {})).get("/x/y")).toBe("from-custom");
    } finally {
      registerSecretDriver("aws", "ssm", (await import("../packages/secrets/drivers/ssm")).createSsmDriver);
    }
    process.env.CLOUDGEAR_SECRETS_DRIVER = "memory";
    await (await createSecretDriver("aws", {})).put("/shared/NAME", "v");
    expect(await (await createSecretDriver("aws", { service: "secretsmanager" })).get("/shared/NAME")).toBe("v");
  });

  test("an unknown service has no driver", async () => {
    await expect(createSecretDriver("aws", { service: "nope" as never })).rejects.toThrow(/No secret driver for "aws\/nope"/);
  });
});

describe("SecretRef", () => {
  test("the environment variable wins, then the store, and a missing secret is an error that names the path", async () => {
    const driver = memory();
    await driver.put("/p/FROM_ENV", "from-store");
    await driver.put("/p/ONLY_STORE", "stored");
    const env = new SecretStore("aws", { driver }).path("/p");
    process.env.FROM_ENV = "from-env";
    expect(await env("FROM_ENV").get()).toBe("from-env");
    expect(await env("ONLY_STORE").get()).toBe("stored");
    await expect(env("MY_ENV_3").get()).rejects.toThrow("Secret /p/MY_ENV_3 was not found; set it with `cloudgear secrets set`");
  });

  test("awaiting a reference does not hang or read anything", async () => {
    const ref = new SecretStore("aws", { driver: memory() }).path("/p")("MY_ENV_1");
    expect(await ref).toBe(ref);
    expect("then" in ref).toBe(false);
  });
});

describe("drivers", () => {
  test("memory lists only direct children and keeps names apart from values", async () => {
    const driver = memory();
    await driver.put("/a/one", "1");
    await driver.put("/a/two", "2");
    await driver.put("/a/deeper/three", "3");
    await driver.put("/b/four", "4");
    expect(await driver.list("/a")).toEqual({ "/a/one": "1", "/a/two": "2" });
    expect(await driver.names("/a")).toEqual(["/a/one", "/a/two"]);
    expect(await driver.getMany(["/a/one", "/a/missing"])).toEqual({ "/a/one": "1" });
    expect(await driver.get("/nope")).toBeNull();
  });

  test("SSM reads with decryption, batches by ten, pages by path and writes SecureStrings", async () => {
    const sent: { name: string; input: any }[] = [];
    const client = {
      send: async (command: { constructor: { name: string }; input: any }) => {
        sent.push({ name: command.constructor.name, input: command.input });
        switch (command.constructor.name) {
          case "GetParameterCommand":
            if (command.input.Name === "/x/missing") throw named("ParameterNotFound");
            return { Parameter: { Name: command.input.Name, Value: "v" } };
          case "GetParametersCommand":
            return { Parameters: command.input.Names.map((n: string) => ({ Name: n, Value: `v-${n}` })) };
          case "GetParametersByPathCommand":
            return command.input.NextToken
              ? { Parameters: [{ Name: "/x/b", Value: "B" }] }
              : { Parameters: [{ Name: "/x/a", Value: "A" }], NextToken: "t" };
          default:
            return {};
        }
      },
    };
    const driver = new SsmSecretDriver(client, "key-id");
    expect(await driver.get("/x/a")).toBe("v");
    expect(await driver.get("/x/missing")).toBeNull();
    expect(sent[0]!.input).toEqual({ Name: "/x/a", WithDecryption: true });

    const names = Array.from({ length: 25 }, (_, i) => `/x/n${i}`);
    const many = await driver.getMany(names);
    expect(Object.keys(many)).toHaveLength(25);
    const batches = sent.filter((c) => c.name === "GetParametersCommand").map((c) => c.input.Names.length);
    expect(batches).toEqual([10, 10, 5]);

    sent.length = 0;
    expect(await driver.list("/x")).toEqual({ "/x/a": "A", "/x/b": "B" });
    expect(sent.map((c) => c.input.WithDecryption)).toEqual([true, true]);
    sent.length = 0;
    expect(await driver.names("/x")).toEqual(["/x/a", "/x/b"]);
    expect(sent.every((c) => c.input.WithDecryption === false)).toBe(true);

    sent.length = 0;
    await driver.put("/x/new", "secret-value");
    expect(sent[0]).toEqual({ name: "PutParameterCommand", input: { Name: "/x/new", Value: "secret-value", Type: "SecureString", Overwrite: true, KeyId: "key-id" } });
  });

  test("Secrets Manager reads by name, lists by prefix and creates what it cannot update", async () => {
    const sent: { name: string; input: any }[] = [];
    const existing = new Set(["/x/a"]);
    const client = {
      send: async (command: { constructor: { name: string }; input: any }) => {
        sent.push({ name: command.constructor.name, input: command.input });
        switch (command.constructor.name) {
          case "GetSecretValueCommand":
            if (!existing.has(command.input.SecretId)) throw named("ResourceNotFoundException");
            return { SecretString: `v-${command.input.SecretId}` };
          case "ListSecretsCommand":
            return { SecretList: [{ Name: "/x/a" }, { Name: "/x/deeper/b" }, { Name: "/xx/c" }] };
          case "PutSecretValueCommand":
            if (!existing.has(command.input.SecretId)) throw named("ResourceNotFoundException");
            return {};
          default:
            return {};
        }
      },
    };
    const driver = new SecretsManagerDriver(client, "kms-1");
    expect(await driver.get("/x/a")).toBe("v-/x/a");
    expect(await driver.get("/x/none")).toBeNull();
    expect(await driver.names("/x")).toEqual(["/x/a"]);
    expect(await driver.list("/x")).toEqual({ "/x/a": "v-/x/a" });
    sent.length = 0;
    await driver.put("/x/a", "again");
    await driver.put("/x/fresh", "new");
    expect(sent.map((c) => c.name)).toEqual(["PutSecretValueCommand", "PutSecretValueCommand", "CreateSecretCommand"]);
    expect(sent[2]!.input).toEqual({ Name: "/x/fresh", SecretString: "new", KmsKeyId: "kms-1" });
  });
});

describe("secretsLoader", () => {
  const binding = (name: string, env = name, path = "/p"): SecretBindingSpec => ({ provider: "aws", service: "ssm", path, name, env });
  const factoryFor = (driver: SecretDriver) => ({ ssm: () => driver });

  test("fills process.env from the store, never overwrites what is set, and only once", async () => {
    const driver = memory();
    await driver.put("/p/MY_ENV_1", "one");
    await driver.put("/p/MY_ENV_2", "two");
    await driver.put("/p/OLD_NAME", "renamed");
    process.env.MY_ENV_2 = "already";
    let reads = 0;
    const counting: SecretDriver = {
      get: (n) => driver.get(n),
      getMany: async (names) => (reads++, driver.getMany(names)),
      list: (p) => driver.list(p),
      names: (p) => driver.names(p),
      put: (n, v) => driver.put(n, v),
    };
    const load = secretsLoader([binding("MY_ENV_1"), binding("MY_ENV_2"), binding("OLD_NAME", "NEW_NAME")], factoryFor(counting));
    await load();
    await load();
    expect(process.env.MY_ENV_1).toBe("one");
    expect(process.env.MY_ENV_2).toBe("already");
    expect(process.env.NEW_NAME).toBe("renamed");
    expect(reads).toBe(1);
    delete process.env.NEW_NAME;
  });

  test("missing secrets fail with their paths and never their values, and the next call retries", async () => {
    const driver = memory();
    await driver.put("/p/MY_ENV_1", "super-secret-value");
    const load = secretsLoader([binding("MY_ENV_1"), binding("MY_ENV_2"), binding("MY_ENV_3")], factoryFor(driver));
    const err = await load().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err!.message).toBe("Secrets not found: /p/MY_ENV_2, /p/MY_ENV_3; set them with `cloudgear secrets set`");
    expect(err!.message).not.toContain("super-secret-value");
    await driver.put("/p/MY_ENV_2", "b");
    await driver.put("/p/MY_ENV_3", "c");
    await load();
    expect(process.env.MY_ENV_3).toBe("c");
  });

  test("a wildcard binding loads everything under the path that can be a variable name", async () => {
    const driver = memory();
    await driver.put("/w/MY_ENV_1", "one");
    await driver.put("/w/not-a-var", "skipped");
    await driver.put("/w/deeper/MY_ENV_2", "skipped too");
    const load = secretsLoader([{ ...binding("", "", "/w"), all: true }], factoryFor(driver));
    await load();
    expect(process.env.MY_ENV_1).toBe("one");
    expect(process.env["not-a-var"]).toBeUndefined();
    expect(process.env.MY_ENV_2).toBeUndefined();
  });

  test("an empty list does nothing and a store with no bindings is not contacted", async () => {
    await secretsLoader([], {})();
  });
});
