import {
  CreateCacheClusterCommand,
  CreateCacheSubnetGroupCommand,
  CreateReplicationGroupCommand,
  DeleteCacheClusterCommand,
  DeleteCacheSubnetGroupCommand,
  DeleteReplicationGroupCommand,
  DescribeCacheClustersCommand,
  DescribeReplicationGroupsCommand,
} from "@aws-sdk/client-elasticache";
import { CACHE_DEFAULTS } from "@cloudgear/cache";
import type { Adopted, Driver } from "../apply";
import type { DesiredEntry } from "../plan";
import { destroyAllowed, withoutAllowDestroy } from "../protect";
import type { StateEntry } from "../state";
import type { SendClient } from "./index";
import { NETWORK_KEYS, resolveNetwork, type ResolvedNetwork } from "./network";
import { tagList, type Tagger } from "./tags";

export interface ElastiCacheDeps {
  elasticache: SendClient;
  ec2: SendClient;
  region: string;
  tags?: Tagger;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
}

const NODE_TYPES: Record<string, string> = { micro: "cache.t4g.micro", small: "cache.t4g.small", medium: "cache.t4g.medium" };
const WAIT_ATTEMPTS = 80;
const WAIT_MS = 15000;
const FAILED = new Set(["create-failed", "incompatible-network", "snapshot-failed", "restore-failed"]);

interface Wanted {
  engine: string;
  nodeType: string;
}

// What a cache looks like in AWS; a replication group serves valkey and redis, a cluster serves memcached.
interface Found {
  kind: "group" | "cluster";
  status: string;
  nodeType?: string;
  engine?: string;
  host: string;
  port: string;
}

const named = (err: unknown, ...names: string[]): boolean => names.includes((err as { name?: string }).name ?? "");

const wanted = (spec: Record<string, unknown>): Wanted => {
  const options = (spec.options ?? {}) as Record<string, string>;
  return { engine: options.engine ?? CACHE_DEFAULTS.engine, nodeType: NODE_TYPES[options.size ?? CACHE_DEFAULTS.size]! };
};

const networkOptions = (spec: Record<string, unknown>): Record<string, string> => {
  const options = (spec.options ?? {}) as Record<string, string>;
  return Object.fromEntries(NETWORK_KEYS.flatMap((key) => (options[key] !== undefined ? [[key, options[key]!]] : [])));
};

const outputsOf = (id: string, found: Found, network?: ResolvedNetwork): Record<string, string> => ({
  id,
  endpoint: found.host && found.port ? `${found.host}:${found.port}` : "",
  host: found.host,
  port: found.port,
  ...(network ? { vpc_id: network.vpcId, subnet_ids: network.subnetIds.join(","), security_group_ids: network.securityGroupIds.join(",") } : {}),
});

const refusal = (current: StateEntry): string | undefined =>
  destroyAllowed(current) ? undefined : `Refusing to delete cache "${current.physical_name}": it holds data. Declare it with allowDestroy: true, apply, then remove it.`;

function differences(found: Found, want: Wanted): string[] {
  const memcached = want.engine === "memcached";
  return [
    ...(memcached !== (found.kind === "cluster") ? [`it is a ${found.kind === "cluster" ? "memcached" : "valkey or redis"} cache (config: ${want.engine})`] : []),
    ...(found.nodeType && found.nodeType !== want.nodeType ? [`node type is ${found.nodeType} (config: ${want.nodeType})`] : []),
  ];
}

export function elastiCacheDriver(deps: ElastiCacheDeps): Driver {
  const client = deps.elasticache;

  async function find(id: string): Promise<Found | undefined> {
    try {
      const group = (await client.send(new DescribeReplicationGroupsCommand({ ReplicationGroupId: id }))).ReplicationGroups?.[0];
      if (group) {
        const endpoint = group.NodeGroups?.[0]?.PrimaryEndpoint ?? group.ConfigurationEndpoint;
        return { kind: "group", status: group.Status ?? "", nodeType: group.CacheNodeType, host: endpoint?.Address ?? "", port: String(endpoint?.Port ?? "") };
      }
    } catch (err) {
      if (!named(err, "ReplicationGroupNotFoundFault")) throw err;
    }
    try {
      const cluster = (await client.send(new DescribeCacheClustersCommand({ CacheClusterId: id, ShowCacheNodeInfo: true }))).CacheClusters?.[0];
      if (cluster) {
        const endpoint = cluster.ConfigurationEndpoint ?? cluster.CacheNodes?.[0]?.Endpoint;
        return { kind: "cluster", status: cluster.CacheClusterStatus ?? "", nodeType: cluster.CacheNodeType, engine: cluster.Engine, host: endpoint?.Address ?? "", port: String(endpoint?.Port ?? "") };
      }
    } catch (err) {
      if (!named(err, "CacheClusterNotFoundFault")) throw err;
    }
    return undefined;
  }

  // Creating takes minutes; the next apply adopts the cache and keeps waiting if this one gives up.
  async function available(id: string): Promise<Found> {
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
      const found = await find(id);
      if (!found) throw new Error(`Cache "${id}" disappeared while waiting for it`);
      if (FAILED.has(found.status)) throw new Error(`Cache "${id}" ended up ${found.status}; delete it in the console and apply again`);
      if (found.status === "available" && found.host) return found;
      await deps.sleep(WAIT_MS);
    }
    throw new Error(`Cache "${id}" is still not available after ${(WAIT_ATTEMPTS * WAIT_MS) / 60000} minutes; run apply again`);
  }

  async function gone(id: string): Promise<void> {
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
      if (!(await find(id))) return;
      await deps.sleep(WAIT_MS);
    }
    throw new Error(`Cache "${id}" is still being deleted after ${(WAIT_ATTEMPTS * WAIT_MS) / 60000} minutes; run apply again`);
  }

  async function ensure(entry: DesiredEntry): Promise<Record<string, string>> {
    const id = entry.physical_name;
    const want = wanted(entry.spec);
    // Resolved first so a wrong network fails before anything is created.
    const network = await resolveNetwork({ ec2: deps.ec2, region: deps.region, log: deps.log }, networkOptions(entry.spec));
    if (!network) throw new Error(`Cache "${entry.name}" has no network; this is a bug in the generated config`);
    let found = await find(id);
    if (found) {
      const problems = differences(found, want);
      if (problems.length) throw new Error(`Cache "${id}" already exists but ${problems.join(" and ")}; AWS cannot change that in place, so migrate the data by hand and use a new name`);
      deps.log(`adopted existing cache ${id}`);
    } else {
      try {
        await client.send(
          new CreateCacheSubnetGroupCommand({
            CacheSubnetGroupName: id,
            CacheSubnetGroupDescription: `cloudgear: ${entry.name}`,
            SubnetIds: network.subnetIds,
            ...(deps.tags ? { Tags: tagList(deps.tags(entry.name)) } : {}),
          }),
        );
      } catch (err) {
        if (!named(err, "CacheSubnetGroupAlreadyExistsFault")) throw err;
      }
      const common = { CacheNodeType: want.nodeType, CacheSubnetGroupName: id, SecurityGroupIds: network.securityGroupIds, ...(deps.tags ? { Tags: tagList(deps.tags(entry.name)) } : {}) };
      try {
        await client.send(
          want.engine === "memcached"
            ? new CreateCacheClusterCommand({ CacheClusterId: id, Engine: "memcached", NumCacheNodes: 1, ...common })
            : new CreateReplicationGroupCommand({
                ReplicationGroupId: id,
                ReplicationGroupDescription: `cloudgear: ${entry.name}`,
                Engine: want.engine,
                NumCacheClusters: 1,
                AutomaticFailoverEnabled: false,
                AtRestEncryptionEnabled: true,
                TransitEncryptionEnabled: false,
                ...common,
              }),
        );
        deps.log(`creating cache ${id}; this takes several minutes`);
      } catch (err) {
        if (!named(err, "ReplicationGroupAlreadyExistsFault", "CacheClusterAlreadyExistsFault")) throw err;
      }
    }
    found = await available(id);
    return outputsOf(id, found, network);
  }

  return {
    create: (entry) => ensure(entry),
    async update(entry, current) {
      const before = networkOptions(current.spec);
      const after = networkOptions(entry.spec);
      // An imported entry records no network until its first apply.
      if (before.vpc !== undefined && JSON.stringify(Object.entries(before).sort()) !== JSON.stringify(Object.entries(after).sort())) {
        throw new Error(`Cache "${entry.physical_name}": its network cannot change in place; migrate the data by hand and use a new name`);
      }
      return ensure(entry);
    },
    protect: refusal,
    async delete(current) {
      const reason = refusal(current);
      if (reason) throw new Error(reason);
      const id = current.physical_name;
      const found = await find(id);
      if (found) {
        // A cache that is still being created or changed refuses a delete until it settles.
        if (found.status !== "deleting" && !FAILED.has(found.status) && found.status !== "available") await available(id).catch(() => undefined);
        if (found.status !== "deleting") {
          try {
            await client.send(found.kind === "group" ? new DeleteReplicationGroupCommand({ ReplicationGroupId: id }) : new DeleteCacheClusterCommand({ CacheClusterId: id }));
          } catch (err) {
            if (!named(err, "ReplicationGroupNotFoundFault", "CacheClusterNotFoundFault")) throw err;
          }
          deps.log(`deleting cache ${id}; this takes several minutes`);
        }
        await gone(id);
      }
      // The group can still read as in use for a moment after the cache is gone.
      for (let attempt = 0; ; attempt++) {
        try {
          await client.send(new DeleteCacheSubnetGroupCommand({ CacheSubnetGroupName: id }));
          break;
        } catch (err) {
          if (named(err, "CacheSubnetGroupNotFoundFault")) break;
          if (!named(err, "CacheSubnetGroupInUse") || attempt >= 8) throw err;
          await deps.sleep(15000);
        }
      }
      deps.log(`deleted cache ${id}`);
    },
    // Read only; a cache that differs is recorded without its spec so the next plan shows the change.
    async adopt(entry): Promise<Adopted | undefined> {
      const found = await find(entry.physical_name);
      if (!found) return undefined;
      const problems = differences(found, wanted(entry.spec));
      const outputs = outputsOf(entry.physical_name, found);
      if (found.status !== "available") problems.push(`it is ${found.status}, so it has no endpoint yet; apply will wait for it`);
      return problems.length
        ? { outputs, spec: { physical_name: entry.physical_name }, notes: [`cache "${entry.physical_name}": ${problems.join("; ")}; AWS cannot change that in place`] }
        : { outputs, spec: withoutAllowDestroy(entry.spec) };
    },
  };
}
