import {
  CreateRepositoryCommand,
  DeleteLifecyclePolicyCommand,
  DeleteRepositoryCommand,
  DescribeRepositoriesCommand,
  GetLifecyclePolicyCommand,
  PutImageScanningConfigurationCommand,
  PutImageTagMutabilityCommand,
  PutLifecyclePolicyCommand,
} from "@aws-sdk/client-ecr";
import { DEFAULT_KEEP_UNTAGGED_DAYS } from "@cloudgear/registry";
import type { Adopted, Driver } from "../apply";
import type { DesiredEntry } from "../plan";
import type { StateEntry } from "../state";
import type { SendClient } from "./index";
import { tagList, type Tagger } from "./tags";

export interface EcrDeps {
  ecr: SendClient;
  tags?: Tagger;
  log: (message: string) => void;
}

interface Wanted {
  scanOnPush: boolean;
  immutable: boolean;
  keepUntaggedDays?: number;
}

interface Repository {
  repositoryArn?: string;
  repositoryUri?: string;
  imageTagMutability?: string;
  imageScanningConfiguration?: { scanOnPush?: boolean };
}

// "managed" in outputs means cloudgear wrote the lifecycle policy.
const MANAGED = "managed";

function wanted(spec: Record<string, unknown>): Wanted {
  const options = (spec.options ?? {}) as Record<string, string>;
  return {
    scanOnPush: options.scan_on_push !== "false",
    immutable: options.immutable_tags === "true",
    keepUntaggedDays: options.keep_untagged_days === "off" ? undefined : Number(options.keep_untagged_days ?? DEFAULT_KEEP_UNTAGGED_DAYS),
  };
}

export function lifecyclePolicy(days: number): string {
  return JSON.stringify({
    rules: [
      {
        rulePriority: 1,
        description: `cloudgear: expire untagged images after ${days} days`,
        selection: { tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: days },
        action: { type: "expire" },
      },
    ],
  });
}

const canonical = (text: string): string => {
  const sort = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(sort) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sort(v)])) : value;
  try {
    return JSON.stringify(sort(JSON.parse(text)));
  } catch {
    return text;
  }
};

const named = (err: unknown, ...names: string[]): boolean => names.includes((err as { name?: string }).name ?? "");

const outputsOf = (repo: Repository, lifecycle: string): Record<string, string> => ({ arn: repo.repositoryArn ?? "", uri: repo.repositoryUri ?? "", lifecycle });

const refusal = (current: StateEntry): string | undefined =>
  ((current.spec.options ?? {}) as Record<string, string>).allow_destroy === "true"
    ? undefined
    : `Refusing to delete ECR repository "${current.physical_name}": it may hold images. Declare it with allowDestroy: true, apply, then remove it.`;

// Adoption must not grant deletion; the next apply records allow_destroy.
function withoutAllowDestroy(spec: Record<string, unknown>): Record<string, unknown> {
  const { allow_destroy: _ignored, ...options } = (spec.options ?? {}) as Record<string, string>;
  const { options: _before, ...rest } = spec;
  return Object.keys(options).length ? { ...rest, options } : rest;
}

export function ecrDriver(deps: EcrDeps): Driver {
  async function describe(name: string): Promise<Repository | undefined> {
    try {
      const res = await deps.ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [name] }));
      return res.repositories?.[0];
    } catch (err) {
      if (named(err, "RepositoryNotFoundException")) return undefined;
      throw err;
    }
  }

  async function lifecycleOf(name: string): Promise<string | undefined> {
    try {
      const res = await deps.ecr.send(new GetLifecyclePolicyCommand({ repositoryName: name }));
      return res.lifecyclePolicyText;
    } catch (err) {
      if (named(err, "LifecyclePolicyNotFoundException")) return undefined;
      throw err;
    }
  }

  // Brings a repository in line without replacing a lifecycle policy cloudgear did not write.
  async function converge(name: string, repo: Repository, want: Wanted, previousLifecycle: string): Promise<string> {
    if ((repo.imageScanningConfiguration?.scanOnPush ?? false) !== want.scanOnPush) {
      await deps.ecr.send(new PutImageScanningConfigurationCommand({ repositoryName: name, imageScanningConfiguration: { scanOnPush: want.scanOnPush } }));
    }
    if ((repo.imageTagMutability === "IMMUTABLE") !== want.immutable) {
      await deps.ecr.send(new PutImageTagMutabilityCommand({ repositoryName: name, imageTagMutability: want.immutable ? "IMMUTABLE" : "MUTABLE" }));
    }
    const existing = await lifecycleOf(name);
    if (want.keepUntaggedDays === undefined) {
      if (previousLifecycle === MANAGED && existing !== undefined) {
        await deps.ecr.send(new DeleteLifecyclePolicyCommand({ repositoryName: name }));
      }
      return "unmanaged";
    }
    const policy = lifecyclePolicy(want.keepUntaggedDays);
    if (existing !== undefined && canonical(existing) === canonical(policy)) return MANAGED;
    if (existing !== undefined && previousLifecycle !== MANAGED) {
      throw new Error(`ECR repository "${name}" already has a lifecycle policy that cloudgear did not write; set keepUntaggedDays: false to leave it alone, or delete that policy`);
    }
    await deps.ecr.send(new PutLifecyclePolicyCommand({ repositoryName: name, lifecyclePolicyText: policy }));
    return MANAGED;
  }

  async function ensure(entry: DesiredEntry, previousLifecycle: string): Promise<Record<string, string>> {
    const want = wanted(entry.spec);
    let repo = await describe(entry.physical_name);
    if (repo) {
      deps.log(`adopted existing ECR repository ${entry.physical_name}`);
    } else {
      try {
        const created = await deps.ecr.send(
          new CreateRepositoryCommand({
            repositoryName: entry.physical_name,
            imageScanningConfiguration: { scanOnPush: want.scanOnPush },
            imageTagMutability: want.immutable ? "IMMUTABLE" : "MUTABLE",
            ...(deps.tags ? { tags: tagList(deps.tags(entry.name)) } : {}),
          }),
        );
        repo = created.repository;
        deps.log(`created ECR repository ${entry.physical_name}`);
      } catch (err) {
        if (!named(err, "RepositoryAlreadyExistsException")) throw err;
        repo = await describe(entry.physical_name);
      }
    }
    if (!repo) throw new Error(`ECR repository "${entry.physical_name}" could not be created or found`);
    return outputsOf(repo, await converge(entry.physical_name, repo, want, previousLifecycle));
  }

  return {
    create: (entry) => ensure(entry, ""),
    update: (entry, current) => ensure(entry, current.outputs.lifecycle ?? ""),
    protect: refusal,
    async delete(current) {
      const reason = refusal(current);
      if (reason) throw new Error(reason);
      try {
        await deps.ecr.send(new DeleteRepositoryCommand({ repositoryName: current.physical_name, force: true }));
        deps.log(`deleted ECR repository ${current.physical_name}`);
      } catch (err) {
        if (!named(err, "RepositoryNotFoundException")) throw err;
      }
    },
    // Read only; a repository that differs is recorded without its spec so the next plan shows the change.
    async adopt(entry): Promise<Adopted | undefined> {
      const repo = await describe(entry.physical_name);
      if (!repo) return undefined;
      const want = wanted(entry.spec);
      const existing = await lifecycleOf(entry.physical_name);
      const foreignPolicy = want.keepUntaggedDays !== undefined && existing !== undefined && canonical(existing) !== canonical(lifecyclePolicy(want.keepUntaggedDays));
      const sameLifecycle = want.keepUntaggedDays === undefined || (existing !== undefined && !foreignPolicy);
      const differences = [
        ...((repo.imageScanningConfiguration?.scanOnPush ?? false) !== want.scanOnPush ? [`scan on push is ${want.scanOnPush ? "off" : "on"} (config: ${want.scanOnPush ? "on" : "off"})`] : []),
        ...((repo.imageTagMutability === "IMMUTABLE") !== want.immutable ? [`tags are ${want.immutable ? "mutable" : "immutable"} (config: ${want.immutable ? "immutable" : "mutable"})`] : []),
        ...(foreignPolicy ? ["it has a lifecycle policy cloudgear did not write; set keepUntaggedDays: false to leave it alone, or delete that policy"] : []),
        ...(!sameLifecycle && !foreignPolicy ? ["it has no lifecycle policy for untagged images"] : []),
      ];
      const lifecycle = want.keepUntaggedDays !== undefined && sameLifecycle ? MANAGED : "unmanaged";
      return differences.length
        ? { outputs: outputsOf(repo, "unmanaged"), spec: { physical_name: entry.physical_name }, notes: [`ECR repository "${entry.physical_name}": ${differences.join("; ")}`] }
        : { outputs: outputsOf(repo, lifecycle), spec: withoutAllowDestroy(entry.spec) };
    },
  };
}
