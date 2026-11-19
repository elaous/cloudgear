import { Storage } from "@google-cloud/storage";
import type { BlobDriver } from "../driver";

// The part of the Cloud Storage client this driver uses.
export interface GcsClient {
  bucket(name: string): {
    file(key: string): {
      download(): Promise<[Uint8Array]>;
      save(data: Uint8Array, options: { contentType?: string; resumable: boolean }): Promise<unknown>;
      delete(options: { ignoreNotFound: boolean }): Promise<unknown>;
      exists(): Promise<[boolean]>;
    };
    getFiles(options: { prefix: string; autoPaginate: boolean }): Promise<[{ name: string }[], ...unknown[]]>;
  };
}

const isNotFound = (err: unknown): boolean => (err as { code?: unknown })?.code === 404;

export class GcsBlobDriver implements BlobDriver {
  constructor(
    private readonly bucketName: string,
    readonly client: GcsClient = new Storage() as unknown as GcsClient,
  ) {}

  private file(key: string) {
    return this.client.bucket(this.bucketName).file(key);
  }

  async get(key: string) {
    try {
      const [data] = await this.file(key).download();
      return new Uint8Array(data);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async put(key: string, data: Uint8Array, contentType?: string) {
    await this.file(key).save(data, { ...(contentType ? { contentType } : {}), resumable: false });
  }

  async delete(key: string) {
    await this.file(key).delete({ ignoreNotFound: true });
  }

  async list(prefix: string) {
    const [files] = await this.client.bucket(this.bucketName).getFiles({ prefix, autoPaginate: true });
    return files.map((file) => file.name);
  }

  async exists(key: string) {
    const [found] = await this.file(key).exists();
    return found;
  }
}

export const createGcsDriver = (bucket: string): BlobDriver => new GcsBlobDriver(bucket);
