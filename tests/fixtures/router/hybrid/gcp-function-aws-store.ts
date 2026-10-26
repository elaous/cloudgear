import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const archive = new BlobStore("aws", "://archive", { options: { versioning: true } });
const cache = new BlobStore("gcp", "gs://cache", { options: { versioning: true } });

export async function getReport({ id }: { id: string }) {
  return { archived: await archive.getText(id), cached: await cache.getText(id) };
}

export async function warm({ id }: { id: string }) {
  await cache.put(id, "warm");
  return { ok: true };
}

new FunctionRouter("gcp")
  .url("GET", "/report/{id}", getReport)
  .url("POST", "/warm/{id}", warm);
