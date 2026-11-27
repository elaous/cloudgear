import {
  DeleteBucketCorsCommand,
  DeleteBucketWebsiteCommand,
  DeleteObjectsCommand,
  PutBucketCorsCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { normalizeRule, type SiteSettings, type SiteTarget } from "../site-sync";
import type { SendClient } from "./index";

const DELETE_BATCH = 1000;

// The S3 bucket as a place for site files.
export function s3Target(s3: SendClient, bucket: string): SiteTarget {
  return {
    async put(file, body) {
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
    },
    async deleteKeys(keys) {
      for (let start = 0; start < keys.length; start += DELETE_BATCH) {
        const batch = keys.slice(start, start + DELETE_BATCH);
        const result = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
        const failed = (result?.Errors ?? []) as { Key?: string; Message?: string }[];
        if (failed.length) throw new Error(`could not delete ${failed.map((e) => e.Key).join(", ")}: ${failed[0]?.Message ?? "denied"}`);
      }
    },
  };
}

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
