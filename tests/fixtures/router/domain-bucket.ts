import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const assets = new BlobStore("aws", "s3://assets.example.com", { path: "/img" });

export async function link({ key }: { key: string }) {
  return { url: assets.url(key), stored: await assets.exists(key) };
}

new FunctionRouter("aws").url("GET", "/link/{key}", link);
