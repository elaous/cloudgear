import { PartialApplyError, type Adopted, type Driver } from "../apply";
import type { SiteFile } from "../site-files";
import {
  hasSiteSettings,
  inBatches,
  manifestOutput,
  readManifest,
  readSiteFiles,
  removeSiteFiles,
  SITE_MANIFEST,
  siteSettings,
  syncSiteFiles,
  type SiteSettings,
  type SiteTarget,
} from "../site-sync";
import { labelsFrom, resolveProject, type GcpDeps } from "./index";

// The part of @google-cloud/storage this driver uses, so tests can stand in for it.
export interface BucketPolicy {
  bindings: { role: string; members: string[]; condition?: { title?: string; description?: string; expression: string } }[];
  version?: number;
  etag?: string;
}

export interface FileLike {
  save(data: Buffer, options: { contentType: string; resumable: false; metadata: { cacheControl?: string; metadata: Record<string, string> } }): Promise<unknown>;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
}

export interface BucketLike {
  file(name: string): FileLike;
  iam: {
    getPolicy(options?: { requestedPolicyVersion?: number }): Promise<[BucketPolicy, ...unknown[]]>;
    setPolicy(policy: BucketPolicy): Promise<unknown>;
  };
  getMetadata(): Promise<[Record<string, any>, ...unknown[]]>;
  setMetadata(metadata: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface StorageLike {
  createBucket(name: string, metadata: Record<string, unknown>): Promise<unknown>;
  bucket(name: string): BucketLike;
}

const DEFAULT_LOCATION = "US";
const DELETE_CONCURRENCY = 8;

// The bucket as a place for site files.
export function gcsTarget(bucket: BucketLike): SiteTarget {
  return {
    async put(file: SiteFile, body) {
      await bucket.file(file.key).save(body, {
        contentType: file.contentType,
        resumable: false,
        metadata: { ...(file.cacheControl ? { cacheControl: file.cacheControl } : {}), metadata: { sha256: file.sha256 } },
      });
    },
    async deleteKeys(keys) {
      await inBatches(keys, DELETE_CONCURRENCY, async (key) => {
        await bucket.file(key).delete({ ignoreNotFound: true });
      });
    },
  };
}

const websiteOf = (settings: SiteSettings) =>
  settings.indexDocument !== undefined || settings.errorDocument !== undefined
    ? { mainPageSuffix: settings.indexDocument ?? "index.html", notFoundPage: settings.errorDocument ?? null }
    : null;

// GCS has one list for the headers a rule allows and exposes.
const corsOf = (settings: SiteSettings) =>
  settings.cors
    ? settings.cors.map((rule) => ({
        origin: rule.origins,
        method: rule.methods,
        ...(rule.headers?.length || rule.expose_headers?.length ? { responseHeader: [...new Set([...(rule.headers ?? []), ...(rule.expose_headers ?? [])])] } : {}),
        ...(rule.max_age_seconds !== undefined ? { maxAgeSeconds: rule.max_age_seconds } : {}),
      }))
    : null;

// The patch from `had` to `wanted`; PATCH clears a field only when it is null.
export function siteMetadata(wanted: SiteSettings, had: SiteSettings): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (JSON.stringify(websiteOf(wanted)) !== JSON.stringify(websiteOf(had))) patch.website = websiteOf(wanted);
  if (JSON.stringify(corsOf(wanted)) !== JSON.stringify(corsOf(had))) patch.cors = corsOf(wanted);
  return patch;
}

// A creation body has no null fields.
const withoutNulls = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, v) => (v === null ? undefined : v)));

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
      readSiteFiles(options, deps.siteRoot);
      // Versioning starts after the files so cleanup leaves no versions.
      const versioned = options.versioning === "true";
      const hasFiles = !!options.site_dir;
      const settings = withoutNulls(siteMetadata(siteSettings(options), {}));
      const storage = deps.storage(project);
      try {
        await storage.createBucket(entry.physical_name, {
          location,
          ...(options.storage_class ? { storageClass: options.storage_class } : {}),
          versioning: { enabled: versioned && !hasFiles },
          // Private by default: no public access and no per-object ACLs.
          iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
          labels: labelsFrom(deps.labels, entry.name),
          ...settings,
        });
      } catch (err) {
        if (statusOf(err) === 409) {
          throw new Error(`Bucket "${entry.physical_name}" already exists (bucket names are global); run \`cloudgear import\` if it is yours, or use another name`);
        }
        throw err;
      }
      const bucket = storage.bucket(entry.physical_name);
      const uploaded = readManifest(undefined);
      try {
        await syncSiteFiles(gcsTarget(bucket), options, deps.siteRoot, uploaded);
        if (versioned && hasFiles) await bucket.setMetadata({ versioning: { enabled: true } });
      } catch (err) {
        await removeSiteFiles(gcsTarget(bucket), uploaded).catch(() => {});
        await bucket.delete().catch(() => {});
        throw err;
      }
      deps.log(`created bucket ${entry.physical_name} in ${location}`);
      return { name: entry.physical_name, location, project, ...manifestOutput(uploaded) };
    },

    async update(entry, current) {
      const before = (current.outputs.location || locationOf(current.spec)).toUpperCase();
      const after = locationOf(entry.spec);
      if (before !== after) {
        throw new Error(`Bucket "${entry.physical_name}" cannot move from ${before} to ${after}; destroy it (after emptying it) and apply again`);
      }
      const wantedOptions = optionsOf(entry.spec);
      const hadOptions = optionsOf(current.spec);
      const project = current.outputs.project || (await projectFor(entry.spec, entry.physical_name));
      // A bucket cannot move between projects, so a different project is an error, not a silent record.
      if (wantedOptions.project && current.outputs.project && wantedOptions.project !== current.outputs.project) {
        throw new Error(`Bucket "${entry.physical_name}" is in project ${current.outputs.project} and cannot move to ${wantedOptions.project}`);
      }
      const patch: Record<string, unknown> = {};
      if ((wantedOptions.versioning === "true") !== (hadOptions.versioning === "true")) patch.versioning = { enabled: wantedOptions.versioning === "true" };
      if (wantedOptions.storage_class && wantedOptions.storage_class !== hadOptions.storage_class) patch.storageClass = wantedOptions.storage_class;
      Object.assign(patch, siteMetadata(siteSettings(wantedOptions), siteSettings(hadOptions)));
      readSiteFiles(wantedOptions, deps.siteRoot);
      const bucket = deps.storage(project).bucket(entry.physical_name);
      if (Object.keys(patch).length) await bucket.setMetadata(patch);
      const uploaded = readManifest(current.outputs[SITE_MANIFEST]);
      const hadManifest = !!current.outputs[SITE_MANIFEST];
      try {
        await syncSiteFiles(gcsTarget(bucket), wantedOptions, deps.siteRoot, uploaded);
      } catch (err) {
        throw new PartialApplyError(err, { ...current.outputs, ...manifestOutput(uploaded, hadManifest) });
      }
      return manifestOutput(uploaded, hadManifest);
    },

    async delete(current) {
      const project = current.outputs.project || (await projectFor(current.spec, current.physical_name));
      const uploaded = readManifest(current.outputs[SITE_MANIFEST]);
      if (Object.keys(uploaded).length && optionsOf(current.spec).versioning === "true") {
        throw new Error(`Bucket "${current.physical_name}" is versioned and holds site files whose versions cloudgear cannot delete; empty it, or run cloudgear import to keep it, then retry`);
      }
      const bucket = deps.storage(project).bucket(current.physical_name);
      try {
        await removeSiteFiles(gcsTarget(bucket), uploaded);
        await bucket.delete();
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
        const options = optionsOf(entry.spec);
        const notes = [
          ...(hasSiteSettings(siteSettings(options)) ? ["its website and CORS settings are not applied: cloudgear never changes an imported bucket"] : []),
          ...(options.site_dir ? ["its site files are not uploaded: cloudgear never changes an imported bucket"] : []),
        ];
        return { outputs: { name: entry.physical_name, location: String(metadata.location ?? ""), project }, ...(notes.length ? { notes } : {}) };
      } catch (err) {
        const status = statusOf(err);
        if (status === 404) return undefined;
        if (status === 403) throw new Error(`bucket "${entry.physical_name}" exists but these credentials cannot read it (it may belong to another project)`);
        throw err;
      }
    },
  };
}
