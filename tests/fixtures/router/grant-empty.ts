import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore, grant } from "@cloudgear/blob";

const store = new BlobStore("aws", "://granted");

export async function f() {
  grant(store);
}

new FunctionRouter("aws").url("GET", "/f", f);
