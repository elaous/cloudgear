import type { BlobDriver } from "../driver";

const stores = new Map<string, Map<string, Uint8Array>>();

export class MemoryBlobDriver implements BlobDriver {
  constructor(private readonly objects = new Map<string, Uint8Array>()) {}

  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async put(key: string, data: Uint8Array) {
    this.objects.set(key, data);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list(prefix: string) {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
}

// Same location shares data across BlobStore instances.
export function createMemoryDriver(location: string): BlobDriver {
  let objects = stores.get(location);
  if (!objects) stores.set(location, (objects = new Map()));
  return new MemoryBlobDriver(objects);
}
