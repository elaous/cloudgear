import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

export async function f() {
  return {};
}

new FunctionRouter("aws", { functionOptions: { "env.AWS_REGION": "x" } }).url("GET", "/f", f);
