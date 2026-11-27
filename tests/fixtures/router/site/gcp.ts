import { FunctionRouter } from "@cloudgear/functions";
import { BlobStoreWebSite } from "@cloudgear/blob";

const site = new BlobStoreWebSite("gcp", "gs://gcs-site", {
  options: { location: "us-central1" },
  errorDocument: "404.html",
  files: { dir: "./dist", exclude: ["**/*.map"] },
  cors: [{ origins: ["https://gcs.example.com"], methods: ["GET"], headers: ["content-type"], exposeHeaders: ["etag"] }],
});

export const ping = () => ({});
new FunctionRouter("gcp").url("GET", "/ping", ping);
