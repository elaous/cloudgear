import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const data = new BlobStore("aws", "://data", { options: { versioning: true } });

export async function a() {
  return data.list();
}
export async function b() {
  return {};
}

new FunctionRouter("aws", { functionOptions: { tracing: "Active", "env.STAGE": "prod" } })
  .url("GET", "/a", a, { options: { ephemeral_storage_mb: 1024 } })
  .url("POST", "/a", a, { name: "postA", options: { ephemeral_storage_mb: 1024 } })
  .url("GET", "/b", b);
