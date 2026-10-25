import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore, grant } from "@cloudgear/blob";

const store = new BlobStore("aws", "://granted");

export async function f() {
  // @ts-expect-error not a blob access
  grant(store, "execute");
}

new FunctionRouter("aws").url("GET", "/f", f);
