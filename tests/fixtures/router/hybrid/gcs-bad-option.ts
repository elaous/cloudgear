import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const cache = new BlobStore("gcp", "gs://cache", { options: { tracing: "Active" } });

export async function f() {
  return cache.getText("k");
}

new FunctionRouter("gcp").url("GET", "/f", f);
