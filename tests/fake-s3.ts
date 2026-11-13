import { createHash } from "node:crypto";

interface StoredObject {
  body: string;
  etag: string;
  contentType?: string;
  sse?: string;
}

export function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

interface Input {
  Bucket: string;
  Key: string;
  Body?: string;
  IfMatch?: string;
  IfNoneMatch?: string;
  ContentType?: string;
  ServerSideEncryption?: string;
}

type Call = { command: string; input: Input };

export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly calls: Call[] = [];
  // Fails matching calls before they touch objects.
  failWhen?: (call: Call) => Error | undefined;

  async send(command: unknown): Promise<unknown> {
    const { input } = command as { input: Input };
    const name = (command as object).constructor.name;
    const call = { command: name, input };
    this.calls.push(call);
    const failure = this.failWhen?.(call);
    if (failure) throw failure;
    const id = `${input.Bucket}/${input.Key}`;
    const existing = this.objects.get(id);
    switch (name) {
      case "GetObjectCommand": {
        if (!existing) throw s3Error("NoSuchKey", 404);
        return { ETag: existing.etag, Body: { transformToString: async () => existing.body } };
      }
      case "HeadObjectCommand": {
        if (!existing) throw s3Error("NotFound", 404);
        return { ETag: existing.etag };
      }
      case "PutObjectCommand": {
        this.checkPreconditions(input, existing);
        const body = String(input.Body);
        const etag = `"${createHash("md5").update(body).digest("hex")}"`;
        this.objects.set(id, { body, etag, contentType: input.ContentType, sse: input.ServerSideEncryption });
        return { ETag: etag };
      }
      case "DeleteObjectCommand": {
        if (input.IfMatch !== undefined) this.checkPreconditions({ ...input, IfNoneMatch: undefined }, existing);
        this.objects.delete(id);
        return {};
      }
      default:
        throw new Error(`FakeS3: unsupported ${name}`);
    }
  }

  private checkPreconditions(input: Input, existing: StoredObject | undefined) {
    if (input.IfMatch !== undefined) {
      if (!existing) throw s3Error("NoSuchKey", 404);
      if (existing.etag !== input.IfMatch) throw s3Error("PreconditionFailed", 412);
    }
    if (input.IfNoneMatch === "*" && existing) throw s3Error("PreconditionFailed", 412);
  }

  body(bucket: string, key: string): string | undefined {
    return this.objects.get(`${bucket}/${key}`)?.body;
  }

  put(bucket: string, key: string, body: string): void {
    this.objects.set(`${bucket}/${key}`, { body, etag: `"${createHash("md5").update(body).digest("hex")}"` });
  }

  callsOf(command: string): Call[] {
    return this.calls.filter((c) => c.command === command);
  }
}
