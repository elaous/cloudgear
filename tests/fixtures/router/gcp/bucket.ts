import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

export const assets = new BlobStore("gcp", "gs://assets", { options: { project: "my-proj-123", location: "us-central1", versioning: true, storage_class: "NEARLINE" } });
export const plain = new BlobStore("gcp", "gs://plain");

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
