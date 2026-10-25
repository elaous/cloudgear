import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const prefix = "x/";
const store = new BlobStore("aws", "://b", { path: prefix });

export async function f() {
  return store.list();
}

new FunctionRouter("aws").url("GET", "/f", f);
