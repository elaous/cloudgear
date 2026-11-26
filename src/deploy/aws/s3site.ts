import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DeleteBucketCorsCommand,
  DeleteBucketWebsiteCommand,
  DeleteObjectsCommand,
  PutBucketCorsCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { listSiteFiles, siteFilesHash, type SiteFile, type SiteRules } from "../site-files";
import type { SendClient } from "./index";

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

export const SITE_MANIFEST = "site_manifest";
const UPLOAD_CONCURRENCY = 8;
const DELETE_BATCH = 1000;

// Maps each key cloudgear uploaded to a fingerprint of its content and headers.
export type SiteManifest = Record<string, string>;

export const fingerprint = (file: SiteFile): string => createHash("sha256").update(`${file.sha256}\0${file.contentType}\0${file.cacheControl ?? ""}`).digest("hex");

export function readManifest(raw: string | undefined): SiteManifest {
  const manifest: SiteManifest = Object.create(null);
  if (!raw) return manifest;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return manifest;
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") manifest[key] = value;
    return manifest;
  } catch {
    return manifest;
  }
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

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

async function deleteKeys(s3: SendClient, bucket: string, keys: readonly string[]): Promise<void> {
  for (let start = 0; start < keys.length; start += DELETE_BATCH) {
    const batch = keys.slice(start, start + DELETE_BATCH);
    const result = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
    const failed = (result?.Errors ?? []) as { Key?: string; Message?: string }[];
    if (failed.length) throw new Error(`could not delete ${failed.map((e) => e.Key).join(", ")}: ${failed[0]?.Message ?? "denied"}`);
  }
}

async function upload(s3: SendClient, bucket: string, file: SiteFile): Promise<void> {
  const body = fs.readFileSync(file.path);
  if (createHash("sha256").update(body).digest("hex") !== file.sha256) throw new Error(`${file.key} changed while it was being uploaded; run apply again`);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: file.key,
      Body: body,
      ContentType: file.contentType,
      ...(file.cacheControl ? { CacheControl: file.cacheControl } : {}),
      Metadata: { sha256: file.sha256 },
    }),
  );
}

// Uploads new and changed files and deletes removed ones when pruning; `manifest` is updated as it goes, even on failure.
export async function applySiteFiles(
  s3: SendClient,
  bucket: string,
  options: Record<string, string> | undefined,
  root: string | undefined,
  manifest: SiteManifest,
): Promise<void> {
  const files = readSiteFiles(options, root);
  const diff = diffSite(files, manifest);
  await inBatches([...diff.added, ...diff.changed], UPLOAD_CONCURRENCY, async (file) => {
    await upload(s3, bucket, file);
    manifest[file.key] = fingerprint(file);
  });
  if (options?.site_prune === "true") {
    await deleteKeys(s3, bucket, diff.removed);
    for (const key of diff.removed) delete manifest[key];
  }
}

// Removes what cloudgear uploaded so the bucket can be deleted.
export async function removeSiteFiles(s3: SendClient, bucket: string, manifest: SiteManifest): Promise<void> {
  await deleteKeys(s3, bucket, Object.keys(manifest));
}

const normalizeRule = (rule: CorsRuleConfig): CorsRuleConfig => ({
  origins: [...rule.origins],
  methods: [...rule.methods],
  ...(rule.headers?.length ? { headers: [...rule.headers] } : {}),
  ...(rule.expose_headers?.length ? { expose_headers: [...rule.expose_headers] } : {}),
  ...(rule.max_age_seconds !== undefined ? { max_age_seconds: rule.max_age_seconds } : {}),
});

// Sets what differs between `had` and `wanted`.
export async function applySite(s3: SendClient, bucket: string, wanted: SiteSettings, had: SiteSettings): Promise<void> {
  const websiteWanted = wanted.indexDocument !== undefined || wanted.errorDocument !== undefined;
  const websiteHad = had.indexDocument !== undefined || had.errorDocument !== undefined;
  if (websiteWanted) {
    if (wanted.indexDocument !== had.indexDocument || wanted.errorDocument !== had.errorDocument) {
      await s3.send(
        new PutBucketWebsiteCommand({
          Bucket: bucket,
          WebsiteConfiguration: {
            IndexDocument: { Suffix: wanted.indexDocument ?? "index.html" },
            ...(wanted.errorDocument !== undefined ? { ErrorDocument: { Key: wanted.errorDocument } } : {}),
          },
        }),
      );
    }
  } else if (websiteHad) {
    await s3.send(new DeleteBucketWebsiteCommand({ Bucket: bucket }));
  }
  if (wanted.cors) {
    if (JSON.stringify(wanted.cors.map(normalizeRule)) !== JSON.stringify(had.cors?.map(normalizeRule) ?? null)) {
      await s3.send(
        new PutBucketCorsCommand({
          Bucket: bucket,
          CORSConfiguration: {
            CORSRules: wanted.cors.map((rule) => ({
              AllowedOrigins: rule.origins,
              AllowedMethods: rule.methods,
              ...(rule.headers?.length ? { AllowedHeaders: rule.headers } : {}),
              ...(rule.expose_headers?.length ? { ExposeHeaders: rule.expose_headers } : {}),
              ...(rule.max_age_seconds !== undefined ? { MaxAgeSeconds: rule.max_age_seconds } : {}),
            })),
          },
        }),
      );
    }
  } else if (had.cors) {
    await s3.send(new DeleteBucketCorsCommand({ Bucket: bucket }));
  }
}
