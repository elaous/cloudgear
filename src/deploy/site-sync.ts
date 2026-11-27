import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listSiteFiles, siteFilesHash, type SiteFile, type SiteRules } from "./site-files";

export const SITE_MANIFEST = "site_manifest";
const UPLOAD_CONCURRENCY = 8;

// Maps each key cloudgear uploaded to a fingerprint of its content and headers.
export type SiteManifest = Record<string, string>;

export const fingerprint = (file: SiteFile): string => createHash("sha256").update(`${file.sha256}\0${file.contentType}\0${file.cacheControl ?? ""}`).digest("hex");

export function readManifest(raw: string | undefined): SiteManifest {
  const manifest: SiteManifest = Object.create(null);
  if (!raw) return manifest;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new Error(`the recorded list of uploaded site files (${SITE_MANIFEST}) is damaged; restore the state or remove that output`);
  }
  for (const [key, value] of Object.entries(parsed)) manifest[key] = value as string;
  return manifest;
}

// Empty when nothing was ever uploaded; "" clears an earlier manifest.
export function manifestOutput(manifest: SiteManifest, hadManifest = false): Record<string, string> {
  if (Object.keys(manifest).length === 0) return hadManifest ? { [SITE_MANIFEST]: "" } : {};
  return { [SITE_MANIFEST]: JSON.stringify(Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1)))) };
}

const parseList = <T>(raw: string | undefined, fallback: T): T => (raw ? (JSON.parse(raw) as T) : fallback);

export const siteRules = (options: Record<string, string>): SiteRules => ({
  include: parseList<string[]>(options.site_include, []),
  exclude: parseList<string[]>(options.site_exclude, []),
  cacheControl: parseList<{ match: string; value: string }[]>(options.site_cache_control, []),
});

// Lists the site's files, refusing a directory that no longer matches the config's hash.
export function readSiteFiles(options: Record<string, string> | undefined, root: string | undefined): SiteFile[] {
  if (!options?.site_dir) return [];
  if (!root) throw new Error(`site files (${options.site_dir}) cannot be located: the config's directory is unknown`);
  const files = listSiteFiles(path.resolve(root, options.site_dir), siteRules(options), root);
  if (siteFilesHash(files) !== options.site_files_hash) {
    throw new Error(`${options.site_dir} changed since the config was generated; re-run \`cloudgear generate\``);
  }
  return files;
}

export interface SiteDiff {
  added: SiteFile[];
  changed: SiteFile[];
  // Keys cloudgear uploaded earlier that the site no longer holds.
  removed: string[];
}

export function diffSite(files: readonly SiteFile[], manifest: SiteManifest): SiteDiff {
  const wanted = new Set(files.map((file) => file.key));
  return {
    added: files.filter((file) => !Object.hasOwn(manifest, file.key)),
    changed: files.filter((file) => Object.hasOwn(manifest, file.key) && manifest[file.key] !== fingerprint(file)),
    removed: Object.keys(manifest).filter((key) => !wanted.has(key)),
  };
}

export const describeSiteDiff = (diff: SiteDiff, prune: boolean): string =>
  `site files: ${diff.added.length} new, ${diff.changed.length} changed, ${diff.removed.length} ${prune ? "removed" : "no longer in the site (kept)"}`;

export async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < items.length) {
      try {
        await run(items[next++]!);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  if (failure) throw failure.error;
}

export interface CorsRuleConfig {
  origins: string[];
  methods: string[];
  headers?: string[];
  expose_headers?: string[];
  max_age_seconds?: number;
}

// Website and CORS settings; unset fields are absent.
export interface SiteSettings {
  indexDocument?: string;
  errorDocument?: string;
  cors?: CorsRuleConfig[];
}

export function siteSettings(options: Record<string, string> | undefined): SiteSettings {
  return {
    ...(options?.index_document ? { indexDocument: options.index_document } : {}),
    ...(options?.error_document ? { errorDocument: options.error_document } : {}),
    ...(options?.cors ? { cors: JSON.parse(options.cors) as CorsRuleConfig[] } : {}),
  };
}

export const hasSiteSettings = (settings: SiteSettings): boolean => settings.indexDocument !== undefined || settings.errorDocument !== undefined || settings.cors !== undefined;

export const normalizeRule = (rule: CorsRuleConfig): CorsRuleConfig => ({
  origins: [...rule.origins],
  methods: [...rule.methods],
  ...(rule.headers?.length ? { headers: [...rule.headers] } : {}),
  ...(rule.expose_headers?.length ? { expose_headers: [...rule.expose_headers] } : {}),
  ...(rule.max_age_seconds !== undefined ? { max_age_seconds: rule.max_age_seconds } : {}),
});

// Where a provider stores the files of a site.
export interface SiteTarget {
  // Writes one file; `body` is its verified content.
  put(file: SiteFile, body: Buffer): Promise<void>;
  deleteKeys(keys: readonly string[]): Promise<void>;
}

async function upload(target: SiteTarget, file: SiteFile): Promise<void> {
  const body = fs.readFileSync(file.path);
  if (createHash("sha256").update(body).digest("hex") !== file.sha256) throw new Error(`${file.key} changed while it was being uploaded; run apply again`);
  await target.put(file, body);
}

// Uploads new and changed files and deletes removed ones when pruning; `manifest` is updated as it goes, even on failure.
export async function syncSiteFiles(target: SiteTarget, options: Record<string, string> | undefined, root: string | undefined, manifest: SiteManifest): Promise<void> {
  const files = readSiteFiles(options, root);
  const diff = diffSite(files, manifest);
  await inBatches([...diff.added, ...diff.changed], UPLOAD_CONCURRENCY, async (file) => {
    await upload(target, file);
    manifest[file.key] = fingerprint(file);
  });
  if (options?.site_prune === "true") {
    await target.deleteKeys(diff.removed);
    for (const key of diff.removed) delete manifest[key];
  }
}

// Removes what cloudgear uploaded so the bucket can be deleted.
export async function removeSiteFiles(target: SiteTarget, manifest: SiteManifest): Promise<void> {
  await target.deleteKeys(Object.keys(manifest));
}
