import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { BlobDriver } from "../driver";

export class S3BlobDriver implements BlobDriver {
  constructor(
    private readonly bucket: string,
    readonly client = new S3Client({}),
  ) {}

  async get(key: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.Body ? await res.Body.transformToByteArray() : new Uint8Array();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw withAccessHint(err);
    }
  }

  async put(key: string, data: Uint8Array, contentType?: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const object of res.Contents ?? []) if (object.Key) keys.push(object.Key);
      token = res.NextContinuationToken;
    } while (token);
    return keys;
  }

  async exists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw withAccessHint(err);
    }
  }
}

// S3 returns AccessDenied for missing keys without ListBucket.
function withAccessHint(err: unknown): unknown {
  if ((err as { name?: string })?.name !== "AccessDenied") return err;
  return new Error(
    `${(err as Error).message} (AccessDenied; S3 also returns this for a missing key when the caller cannot list the whole bucket, as with a prefix-scoped store)`,
    { cause: err },
  );
}

export const createS3Driver = (bucket: string, options: { region?: string } = {}): BlobDriver =>
  new S3BlobDriver(bucket, new S3Client(options.region ? { region: options.region } : {}));

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === "NoSuchKey" || name === "NotFound";
}
