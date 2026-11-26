import {
  DeleteBucketCorsCommand,
  DeleteBucketWebsiteCommand,
  PutBucketCorsCommand,
  PutBucketWebsiteCommand,
} from "@aws-sdk/client-s3";
import type { SendClient } from "./index";

export interface CorsRuleConfig {
  origins: string[];
  methods: string[];
  headers?: string[];
  expose_headers?: string[];
  max_age_seconds?: number;
}

// What a website bucket is configured with; undefined fields are not set.
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

// Files are uploaded by a later step; an apply that would skip them fails instead.
export function assertNoUploads(options: Record<string, string> | undefined, bucket: string): void {
  if (options?.site_dir) throw new Error(`Bucket "${bucket}": uploading site files (${options.site_dir}) is not supported by apply yet; remove files from the BlobStoreWebSite`);
}

const normalizeRule = (rule: CorsRuleConfig): CorsRuleConfig => ({
  origins: [...rule.origins],
  methods: [...rule.methods],
  ...(rule.headers?.length ? { headers: [...rule.headers] } : {}),
  ...(rule.expose_headers?.length ? { expose_headers: [...rule.expose_headers] } : {}),
  ...(rule.max_age_seconds !== undefined ? { max_age_seconds: rule.max_age_seconds } : {}),
});

// Makes the bucket's website and CORS configuration match `wanted`, touching only what differs from `had`.
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
