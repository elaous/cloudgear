import type { Adopted, Driver } from "../apply";
import { labelsFrom, resolveProject, type GcpDeps } from "./index";

// The part of @google-cloud/storage this driver uses, so tests can stand in for it.
export interface BucketLike {
  getMetadata(): Promise<[Record<string, any>, ...unknown[]]>;
  setMetadata(metadata: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface StorageLike {
  createBucket(name: string, metadata: Record<string, unknown>): Promise<unknown>;
  bucket(name: string): BucketLike;
}

const DEFAULT_LOCATION = "US";

const statusOf = (err: unknown): number | undefined => {
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
};

const optionsOf = (spec: Record<string, unknown>): Record<string, string> => (spec.options ?? {}) as Record<string, string>;
const locationOf = (spec: Record<string, unknown>): string => (optionsOf(spec).location || (spec.region as string | undefined) || DEFAULT_LOCATION).toUpperCase();

export function gcsDriver(deps: GcpDeps): Driver {
  const projectFor = (spec: Record<string, unknown>, name: string) => resolveProject(deps, optionsOf(spec).project, `Bucket "${name}"`);

  return {
    async create(entry) {
      const project = await projectFor(entry.spec, entry.physical_name);
      const options = optionsOf(entry.spec);
      const location = locationOf(entry.spec);
      try {
        await deps.storage(project).createBucket(entry.physical_name, {
          location,
          ...(options.storage_class ? { storageClass: options.storage_class } : {}),
          versioning: { enabled: options.versioning === "true" },
          // Private by default: no public access and no per-object ACLs.
          iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
          labels: labelsFrom(deps.labels, entry.name),
        });
      } catch (err) {
        if (statusOf(err) === 409) {
          throw new Error(`Bucket "${entry.physical_name}" already exists (bucket names are global); run \`cloudgear import\` if it is yours, or use another name`);
        }
        throw err;
      }
      deps.log(`created bucket ${entry.physical_name} in ${location}`);
      return { name: entry.physical_name, location, project };
    },

    async update(entry, current) {
      const before = (current.outputs.location || locationOf(current.spec)).toUpperCase();
      const after = locationOf(entry.spec);
      if (before !== after) {
        throw new Error(`Bucket "${entry.physical_name}" cannot move from ${before} to ${after}; destroy it (after emptying it) and apply again`);
      }
      const wanted = optionsOf(entry.spec).versioning === "true";
      const had = optionsOf(current.spec).versioning === "true";
      if (wanted !== had) {
        const project = current.outputs.project || (await projectFor(entry.spec, entry.physical_name));
        await deps.storage(project).bucket(entry.physical_name).setMetadata({ versioning: { enabled: wanted } });
      }
      return {};
    },

    async delete(current) {
      const project = current.outputs.project || (await projectFor(current.spec, current.physical_name));
      try {
        await deps.storage(project).bucket(current.physical_name).delete();
      } catch (err) {
        const status = statusOf(err);
        if (status === 404) return;
        if (status === 409) throw new Error(`Bucket "${current.physical_name}" is not empty; empty it, or run cloudgear import to keep it, then retry`);
        throw err;
      }
    },

    // Read only; a bucket is recorded, never changed.
    async adopt(entry): Promise<Adopted | undefined> {
      const project = await projectFor(entry.spec, entry.physical_name);
      try {
        const [metadata] = await deps.storage(project).bucket(entry.physical_name).getMetadata();
        return { outputs: { name: entry.physical_name, location: String(metadata.location ?? ""), project } };
      } catch (err) {
        const status = statusOf(err);
        if (status === 404) return undefined;
        if (status === 403) throw new Error(`bucket "${entry.physical_name}" exists but these credentials cannot read it (it may belong to another project)`);
        throw err;
      }
    },
  };
}
