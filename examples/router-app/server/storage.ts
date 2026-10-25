import { BlobStore } from "@cloudgear/blob";

export const archive = new BlobStore("aws", "s3://cloudgear-example-archive");
