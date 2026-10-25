import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const store = new BlobStore("aws", "://b", { path: "a/../b" });

export async function f() {
  return store.list();
}

new FunctionRouter("aws").url("GET", "/f", f);
