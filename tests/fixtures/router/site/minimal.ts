import { FunctionRouter } from "@cloudgear/functions";
import { BlobStoreWebSite } from "@cloudgear/blob";

const site = new BlobStoreWebSite("aws", "s3://plain-site");

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
