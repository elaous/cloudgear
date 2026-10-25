import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const store = new BlobStore("gcp", "gs://elsewhere");

export async function read() {
  return store.list();
}

new FunctionRouter("aws").url("GET", "/x", read);
