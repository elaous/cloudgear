import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore, grant } from "@cloudgear/blob";

const store = new BlobStore("aws", "://clients");

export async function raw() {
  const s3 = await store.client();
  return s3.config.region();
}

export async function narrowed() {
  grant(store, "read");
  const s3 = await store.client();
  return s3.config.region();
}

new FunctionRouter("aws").url("GET", "/raw", raw).url("GET", "/narrowed", narrowed);
