import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
const data = new BlobStore("aws", "://data", { options: { versioning: "maybe" } });
export async function f() {
  return {};
}

new FunctionRouter("aws").url("GET", "/f", f); void data;
