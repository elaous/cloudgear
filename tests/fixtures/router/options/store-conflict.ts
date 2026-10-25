import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
const a = new BlobStore("aws", "://data", { options: { versioning: true } });
const b = new BlobStore("aws", "://data", { options: { versioning: false } });
export async function f() {
  return {};
}

new FunctionRouter("aws").url("GET", "/f", f); void a; void b;
