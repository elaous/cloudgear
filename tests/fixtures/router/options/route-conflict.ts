import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

export async function f() {
  return {};
}

new FunctionRouter("aws").url("GET", "/f", f, { options: { tracing: "Active" } }).url("POST", "/f", f, { name: "postF", options: { tracing: "PassThrough" } });
