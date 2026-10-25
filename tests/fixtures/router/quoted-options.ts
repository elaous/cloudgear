import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const store = new BlobStore("aws", "://quoted", { "path": "secret" });

export async function f() {
  return store.list();
}

new FunctionRouter("aws", { "authenticated": "none" }).url("GET", "/f", f, { "name": "listF" });
