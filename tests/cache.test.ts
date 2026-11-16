import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cache } from "@cloudgear/cache";
import { analyzeApp } from "../src/analyze/app";
import { adoptEntries } from "../src/deploy/adopt";
import { apply, type Drivers } from "../src/deploy/apply";
import { awsDrivers, type SendClient } from "../src/deploy/aws";
import { OUTPUT_REFERENCE, plan } from "../src/deploy/plan";
import { stateKey } from "../src/deploy/state";
import { cacheIdFor } from "../src/names";
import { validateOptions } from "../src/providers";
import type { CloudgearConfig } from "../src/config/schema";
import { generate } from "../src/generate";
import { baseConfig, emptyState, fakeAws, fn } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "cache", `${name}.ts`);
const KEY = stateKey({ type: "@aws.ElastiCache", name: "cache.sessions" });
const VPC_POLICY = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole";
const NETWORK = { vpc: "default" };

const cacheResource = (options: Record<string, string> = {}, physical = "app-sessions") => ({
  name: "cache.sessions",
  type: "@aws.ElastiCache",
  physical_name: physical,
  dry: false,
  source: "setup.ts:1",
  options: { ...NETWORK, ...options },
});
const configWith = (options?: Record<string, string>, physical?: string): CloudgearConfig => baseConfig({ resource: [cacheResource(options, physical)], function: [] });
const empty = () => baseConfig({ resource: [], function: [] });

interface Group {
  status: string;
  busy: number;
  nodeType: string;
  host: string;
  engine: string;
  kind: "group" | "cluster";
}

function fakeElastiCache(initial: Record<string, Partial<Group>> = {}, opts: { stuck?: boolean } = {}) {
  const caches = new Map<string, Group>(Object.entries(initial).map(([id, g]) => [id, { status: "available", busy: 0, nodeType: "cache.t4g.micro", host: `${id}.cache.internal`, engine: "valkey", kind: "group", ...g }]));
  const subnetGroups = new Map<string, { SubnetIds: string[] }>();
  const calls: { name: string; input: any }[] = [];
  const sleeps: number[] = [];
  const err = (name: string) => Object.assign(new Error(name), { name });
  const client: SendClient = {
    async send(command) {
      const name = command.constructor.name as string;
      const input = command.input;
      calls.push({ name, input });
      switch (name) {
        case "CreateCacheSubnetGroupCommand":
          if (subnetGroups.has(input.CacheSubnetGroupName)) throw err("CacheSubnetGroupAlreadyExistsFault");
          subnetGroups.set(input.CacheSubnetGroupName, { SubnetIds: input.SubnetIds });
          return {};
        case "CreateReplicationGroupCommand":
          caches.set(input.ReplicationGroupId, { status: "creating", busy: 2, nodeType: input.CacheNodeType, host: `${input.ReplicationGroupId}.cache.internal`, engine: input.Engine, kind: "group" });
          return {};
        case "CreateCacheClusterCommand":
          caches.set(input.CacheClusterId, { status: "creating", busy: 2, nodeType: input.CacheNodeType, host: `${input.CacheClusterId}.cache.internal`, engine: "memcached", kind: "cluster" });
          return {};
        case "DescribeReplicationGroupsCommand":
        case "DescribeCacheClustersCommand": {
          const id = input.ReplicationGroupId ?? input.CacheClusterId;
          const found = caches.get(id);
          const wantKind = name === "DescribeReplicationGroupsCommand" ? "group" : "cluster";
          if (!found || found.kind !== wantKind) throw err(wantKind === "group" ? "ReplicationGroupNotFoundFault" : "CacheClusterNotFound");
          const status = opts.stuck ? "creating" : found.busy > 0 ? (found.status === "deleting" ? "deleting" : "creating") : found.status;
          if (found.busy > 0 && !opts.stuck) {
            found.busy--;
            if (found.busy === 0 && found.status === "deleting") caches.delete(id);
            else if (found.busy === 0) found.status = "available";
          }
          const endpoint = { Address: found.host, Port: found.kind === "group" ? 6379 : 11211 };
          return found.kind === "group"
            ? { ReplicationGroups: [{ Status: status, CacheNodeType: found.nodeType, NodeGroups: [{ PrimaryEndpoint: endpoint }] }] }
            : { CacheClusters: [{ CacheClusterStatus: status, CacheNodeType: found.nodeType, Engine: found.engine, ConfigurationEndpoint: endpoint }] };
        }
        case "DeleteReplicationGroupCommand":
        case "DeleteCacheClusterCommand": {
          const found = caches.get(input.ReplicationGroupId ?? input.CacheClusterId);
          if (!found) throw err("ReplicationGroupNotFoundFault");
          found.status = "deleting";
          found.busy = 2;
          return {};
        }
        case "DeleteCacheSubnetGroupCommand":
          if (!subnetGroups.delete(input.CacheSubnetGroupName)) throw err("CacheSubnetGroupNotFoundFault");
          return {};
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  return { caches, subnetGroups, calls, sleeps, client, names: () => calls.map((c) => c.name) };
}

function driversFor(cache: ReturnType<typeof fakeElastiCache>): { drivers: Drivers; logs: string[]; ec2: ReturnType<typeof fakeAws> } {
  const ec2 = fakeAws();
  const logs: string[] = [];
  const drivers = awsDrivers({
    region: "eu-west-1",
    tags: { "cloudgear:project": "app" },
    readBundle: () => new Uint8Array(),
    clients: { ec2: ec2.client, elasticache: cache.client },
    sleep: async (ms) => void cache.sleeps.push(ms),
    log: (m) => void logs.push(m),
  });
  return { drivers, logs, ec2 };
}

async function applyConfig(config: CloudgearConfig, state: ReturnType<typeof emptyState>, drivers: Drivers) {
  await apply(plan(config, state), state, drivers, { save: () => {}, log: () => {} });
}

describe("Cache", () => {
  const saved = process.env.CLOUDGEAR_CACHE_SESSIONS;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLOUDGEAR_CACHE_SESSIONS;
    else process.env.CLOUDGEAR_CACHE_SESSIONS = saved;
  });

  test("validates the provider, name, engine and size without side effects", () => {
    expect(new Cache("aws", "sessions", { engine: "redis", size: "small" }).name).toBe("sessions");
    expect(() => new Cache("gcp" as "aws", "s")).toThrow(/not supported yet/);
    expect(() => new Cache("aws", "1bad")).toThrow(/Invalid cache name/);
    expect(() => new Cache("aws", "s", { engine: "dynamo" as "redis" })).toThrow(/Unsupported cache engine/);
    expect(() => new Cache("aws", "s", { size: "huge" as "small" })).toThrow(/Unsupported cache size/);
  });

  test("location reads the environment cloudgear sets in deployed functions", () => {
    const cache = new Cache("aws", "sessions");
    delete process.env.CLOUDGEAR_CACHE_SESSIONS;
    expect(() => cache.location).toThrow(/CLOUDGEAR_CACHE_SESSIONS is not set/);
    process.env.CLOUDGEAR_CACHE_SESSIONS = "cache.internal:6379";
    expect([cache.location, cache.host, cache.port]).toEqual(["cache.internal:6379", "cache.internal", 6379]);
    expect(Cache.envVarFor("my-cache.v2")).toBe("CLOUDGEAR_CACHE_MY_CACHE_V2");
  });

  test("physical ids are valid ElastiCache ids", () => {
    expect(cacheIdFor("tranquilo-app", "sessions")).toBe("tranquilo-app-sessions");
    expect(cacheIdFor("App_1", "My_Cache")).toBe("app-1-my-cache");
    expect(cacheIdFor("1app", "x")).toMatch(/^c-1app-x$/);
    const long = cacheIdFor("p".repeat(50), "sessions");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
  });
});

describe("analysis", () => {
  test("a cache becomes a resource, and only the functions that use it join its network and read its endpoint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-"));
    const { config } = await generate({ entry: fixture("basic"), configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "app" });
    expect(config.resource.map((r) => [r.name, r.type, r.physical_name, r.options])).toEqual([["cache.sessions", "@aws.ElastiCache", "app-sessions", { vpc: "default" }]]);
    const byName = Object.fromEntries(config.function.map((f) => [f.name, f]));
    expect(byName.withCache!.env).toEqual([{ key: "CLOUDGEAR_CACHE_SESSIONS", value_from: "cache.sessions", output: "endpoint" }]);
    expect(byName.withCache!.options).toEqual({ vpc: "default" });
    expect(byName.plain!.env).toEqual([]);
    expect(byName.plain!.options).toBeUndefined();
    expect(byName.withCache!.permission).toEqual([]);
  });

  test("a named network and the engine and size reach the resource and the function", async () => {
    const model = analyzeApp(fixture("network"));
    expect(model.caches[0]).toMatchObject({ engine: "memcached", size: "small", allowDestroy: true, network: { vpc: "vpc-0abc1234", subnets: "subnet-aaaa1111", security_groups: "sg-0def4001" } });
    expect(model.functions[0]!.options).toEqual({ vpc: "vpc-0abc1234", subnets: "subnet-aaaa1111", security_groups: "sg-0def4001" });
  });

  test("a function whose network differs from its cache's, and a declaration problem, are errors", () => {
    expect(() => analyzeApp(fixture("mismatch"))).toThrow(/"withCache" uses cache "sessions", which is in a different network/);
    expect(() => analyzeApp(fixture("two-networks"))).toThrow(/"both" uses cache "b", which is in a different network/);
    expect(() => analyzeApp(fixture("duplicate"))).toThrow(/Cache "same" is also declared at/);
    expect(() => analyzeApp(fixture("typo"))).toThrow(/unknown Cache option "enginee" \(supported: engine, size, network, allowDestroy\)/);
    expect(() => analyzeApp(fixture("not-assigned"))).toThrow(/assign new Cache\(\.\.\.\) to a variable/);
    expect(() => analyzeApp(fixture("bad-engine"))).toThrow(/Unsupported cache engine "dynamo"/);
  });
});

describe("planning", () => {
  test("a function reading the endpoint depends on the cache and is refreshed when it changes", () => {
    const config = baseConfig({
      resource: [cacheResource()],
      function: [fn({ permission: [], env: [{ key: "CLOUDGEAR_CACHE_SESSIONS", value_from: "cache.sessions", output: "endpoint" }], options: NETWORK })],
    });
    const actions = plan(config, emptyState());
    const entry = actions.find((a) => a.type === "@aws.Lambda")!.desired!;
    expect((entry.spec.env as Record<string, string>).CLOUDGEAR_CACHE_SESSIONS).toBe(`${OUTPUT_REFERENCE}${KEY}#endpoint`);
    expect(entry.deps).toEqual([KEY]);
    expect(entry.refresh).toBe(true);
    expect(actions.map((a) => a.type)).toEqual(["@aws.ElastiCache", "@aws.Lambda"]);
  });
});

describe("elasticache driver", () => {
  test("creates a valkey cache in the network, waiting until it is available", async () => {
    const cache = fakeElastiCache();
    const { drivers, logs } = driversFor(cache);
    const state = emptyState();
    await applyConfig(configWith(), state, drivers);
    expect(cache.calls.find((c) => c.name === "CreateCacheSubnetGroupCommand")!.input).toMatchObject({ CacheSubnetGroupName: "app-sessions", SubnetIds: ["subnet-aaaa1111", "subnet-bbbb2222"] });
    expect(cache.calls.find((c) => c.name === "CreateReplicationGroupCommand")!.input).toMatchObject({
      ReplicationGroupId: "app-sessions",
      Engine: "valkey",
      CacheNodeType: "cache.t4g.micro",
      NumCacheClusters: 1,
      CacheSubnetGroupName: "app-sessions",
      SecurityGroupIds: ["sg-0def4001"],
      AtRestEncryptionEnabled: true,
      TransitEncryptionEnabled: false,
      AutomaticFailoverEnabled: false,
    });
    expect(cache.sleeps.length).toBeGreaterThan(0);
    expect(logs).toContain("creating cache app-sessions; this takes several minutes");
    expect(state.entries[KEY]!.outputs).toMatchObject({ id: "app-sessions", endpoint: "app-sessions.cache.internal:6379", host: "app-sessions.cache.internal", port: "6379", vpc_id: "vpc-0def0001" });
    expect(plan(configWith(), state).every((a) => a.op === "noop")).toBe(true);
  });

  test("a memcached cache is a cache cluster, and engine and size choose the node", async () => {
    const cache = fakeElastiCache();
    await applyConfig(configWith({ engine: "memcached", size: "medium" }), emptyState(), driversFor(cache).drivers);
    expect(cache.calls.find((c) => c.name === "CreateCacheClusterCommand")!.input).toMatchObject({ CacheClusterId: "app-sessions", Engine: "memcached", NumCacheNodes: 1, CacheNodeType: "cache.t4g.medium" });
    expect(cache.names()).not.toContain("CreateReplicationGroupCommand");
  });

  test("an existing cache is adopted without creating anything, and a mismatch is refused", async () => {
    const cache = fakeElastiCache({ "app-sessions": {} });
    const { drivers, logs } = driversFor(cache);
    await applyConfig(configWith(), emptyState(), drivers);
    expect(cache.names().some((n) => n.startsWith("Create"))).toBe(false);
    expect(logs).toContain("adopted existing cache app-sessions");

    await expect(applyConfig(configWith({ size: "small" }), emptyState(), driversFor(cache).drivers)).rejects.toThrow(/node type is cache.t4g.micro \(config: cache.t4g.small\)/);
    await expect(applyConfig(configWith({ engine: "memcached" }), emptyState(), driversFor(cache).drivers)).rejects.toThrow(/it is a valkey or redis cache \(config: memcached\)/);
  });

  test("a bad network fails before anything is created", async () => {
    const cache = fakeElastiCache();
    const { drivers } = driversFor(cache);
    await expect(applyConfig(configWith({ vpc: "vpc-0abc1234", subnets: "subnet-dddd4444" }), emptyState(), drivers)).rejects.toThrow(/Subnets subnet-dddd4444 are not in VPC vpc-0abc1234/);
    expect(cache.names()).toEqual([]);
  });

  test("a cache that never becomes available fails clearly, and the next apply adopts it", async () => {
    const stuck = fakeElastiCache({}, { stuck: true });
    await expect(applyConfig(configWith(), emptyState(), driversFor(stuck).drivers)).rejects.toThrow(/still not available after 20 minutes; run apply again/);
    expect(stuck.sleeps).toHaveLength(80);
    const retry = fakeElastiCache({ "app-sessions": {} });
    await applyConfig(configWith(), emptyState(), driversFor(retry).drivers);
    expect(retry.names().some((n) => n.startsWith("Create"))).toBe(false);
  });

  test("the network cannot change in place, but an import followed by apply works", async () => {
    const cache = fakeElastiCache();
    const state = emptyState();
    await applyConfig(configWith(), state, driversFor(cache).drivers);
    await expect(applyConfig(configWith({ vpc: "vpc-0abc1234" }), state, driversFor(cache).drivers)).rejects.toThrow(/its network cannot change in place/);

    const existing = fakeElastiCache({ "app-sessions": {} });
    const imported = emptyState();
    const { drivers } = driversFor(existing);
    expect((await adoptEntries(plan(configWith({ allow_destroy: "true" }), imported), imported, drivers, () => true)).adopted).toHaveLength(1);
    await expect(applyConfig(empty(), imported, drivers)).rejects.toThrow(/Nothing was changed/);
    await applyConfig(configWith({ allow_destroy: "true" }), imported, drivers);
    expect(imported.entries[KEY]!.outputs.vpc_id).toBe("vpc-0def0001");
  });

  test("destroy refuses an unprotected cache before changing anything, and deletes a protected one with its subnet group", async () => {
    const guarded = fakeElastiCache();
    const guardedDrivers = driversFor(guarded).drivers;
    const savedGuarded = emptyState();
    await applyConfig(configWith(), savedGuarded, guardedDrivers);
    await expect(applyConfig(empty(), savedGuarded, guardedDrivers)).rejects.toThrow(/^Nothing was changed\. Refusing to delete cache "app-sessions"/);
    expect(guarded.caches.size).toBe(1);

    const open = fakeElastiCache();
    const openDrivers = driversFor(open).drivers;
    const savedOpen = emptyState();
    await applyConfig(configWith({ allow_destroy: "true" }), savedOpen, openDrivers);
    await applyConfig(empty(), savedOpen, openDrivers);
    expect(open.caches.size).toBe(0);
    expect(open.subnetGroups.size).toBe(0);
    expect(open.names().indexOf("DeleteReplicationGroupCommand")).toBeLessThan(open.names().indexOf("DeleteCacheSubnetGroupCommand"));
    expect(savedOpen.entries).toEqual({});
  });

  test("adopt reads only, records the spec when the cache matches, and explains when not", async () => {
    const cache = fakeElastiCache({ "app-sessions": {} });
    const { drivers } = driversFor(cache);
    const [entry] = plan(configWith({ allow_destroy: "true" }), emptyState()).map((a) => a.desired!);
    const ok = await drivers["@aws.ElastiCache"]!.adopt!(entry!, { entry: () => undefined });
    expect(ok!.spec).toEqual({ physical_name: "app-sessions", region: "", options: NETWORK });
    expect(ok!.outputs.endpoint).toBe("app-sessions.cache.internal:6379");
    expect(cache.names().every((n) => n.startsWith("Describe"))).toBe(true);
    const [other] = plan(configWith({ size: "medium" }), emptyState()).map((a) => a.desired!);
    const mismatch = await drivers["@aws.ElastiCache"]!.adopt!(other!, { entry: () => undefined });
    expect(mismatch!.spec).toEqual({ physical_name: "app-sessions" });
    expect(mismatch!.notes![0]).toMatch(/node type is cache.t4g.micro \(config: cache.t4g.medium\)/);
    expect(await driversFor(fakeElastiCache()).drivers["@aws.ElastiCache"]!.adopt!(entry!, { entry: () => undefined })).toBeUndefined();
  });
});

describe("function and cache together", () => {
  const withFunction = (physical = "app-sessions", options: Record<string, string> = {}): CloudgearConfig =>
    baseConfig({
      resource: [cacheResource(options, physical)],
      function: [fn({ permission: [], env: [{ key: "CLOUDGEAR_CACHE_SESSIONS", value_from: "cache.sessions", output: "endpoint" }], options: NETWORK })],
    });
  const cacheAnswers = (host: (id: string) => string) => {
    const live = new Set<string>();
    return {
      CreateReplicationGroupCommand: (input: any) => (live.add(input.ReplicationGroupId), {}),
      DeleteReplicationGroupCommand: (input: any) => (live.delete(input.ReplicationGroupId), {}),
      DescribeReplicationGroupsCommand: (input: any) => {
        if (!live.has(input.ReplicationGroupId)) throw Object.assign(new Error("nf"), { name: "ReplicationGroupNotFoundFault" });
        return { ReplicationGroups: [{ Status: "available", CacheNodeType: "cache.t4g.micro", NodeGroups: [{ PrimaryEndpoint: { Address: host(input.ReplicationGroupId), Port: 6379 } }] }] };
      },
    };
  };

  test("the function is created after the cache, with its endpoint in the environment and in the cache's network", async () => {
    const aws = fakeAws(cacheAnswers((id) => `${id}.cache.internal`));
    const state = emptyState();
    await apply(plan(withFunction(), state), state, aws.drivers, { save: () => {} });
    const names = aws.names();
    expect(names.indexOf("CreateReplicationGroupCommand")).toBeLessThan(names.indexOf("CreateFunctionCommand"));
    const created = aws.of("CreateFunctionCommand")[0];
    expect(created.Environment.Variables.CLOUDGEAR_CACHE_SESSIONS).toBe("app-sessions.cache.internal:6379");
    expect(created.VpcConfig.SecurityGroupIds).toEqual(["sg-0def4001"]);
    expect(aws.of("AttachRolePolicyCommand").map((c) => c.PolicyArn)).toContain(VPC_POLICY);
  });

  test("a function applied before its cache fails instead of getting an empty endpoint", async () => {
    const aws = fakeAws();
    const state = emptyState();
    const onlyFunction = plan(withFunction(), state).filter((a) => a.type === "@aws.Lambda");
    await expect(apply(onlyFunction, state, aws.drivers, { save: () => {} })).rejects.toThrow(/has no endpoint yet, so CLOUDGEAR_CACHE_SESSIONS cannot be set; apply it first/);
    expect(aws.names()).not.toContain("CreateFunctionCommand");
  });

  test("replacing the cache updates the function with the new endpoint", async () => {
    const aws = fakeAws(cacheAnswers((id) => `${id}.cache.internal`));
    const state = emptyState();
    await apply(plan(withFunction("app-a", { allow_destroy: "true" }), state), state, aws.drivers, { save: () => {} });
    const before = aws.calls.length;
    await apply(plan(withFunction("app-b", { allow_destroy: "true" }), state), state, aws.drivers, { save: () => {} });
    const update = aws.calls.slice(before).find((c) => c.name === "UpdateFunctionConfigurationCommand");
    expect(update!.input.Environment.Variables.CLOUDGEAR_CACHE_SESSIONS).toBe("app-b.cache.internal:6379");
  });
});

describe("option validation", () => {
  test("ElastiCache options are checked", () => {
    validateOptions("aws", "@aws.ElastiCache", { engine: "redis", size: "small", vpc: "default", allow_destroy: "true" }, "c");
    expect(() => validateOptions("aws", "@aws.ElastiCache", { engine: "dynamo" }, "c")).toThrow(/must be one of valkey, redis, memcached/);
    expect(() => validateOptions("aws", "@aws.ElastiCache", { size: "huge" }, "c")).toThrow(/must be one of micro, small, medium/);
    expect(() => validateOptions("aws", "@aws.ElastiCache", { vpc: "vpc-xyz" }, "c")).toThrow(/must be "default" or a VPC id/);
    expect(() => validateOptions("aws", "@aws.ElastiCache", { tier: "x" }, "c")).toThrow(/unknown option "tier"/);
  });
});
