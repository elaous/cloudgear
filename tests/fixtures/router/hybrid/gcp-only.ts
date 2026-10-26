import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const cache = new BlobStore("gcp", "gs://cache");

export async function get({ id }: { id: string }) {
  return cache.getText(id);
}

new FunctionRouter("gcp").url("GET", "/get/{id}", get);
