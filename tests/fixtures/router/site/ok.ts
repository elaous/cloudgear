import { FunctionRouter } from "@cloudgear/functions";
import { BlobStoreWebSite } from "@cloudgear/blob";

const domain = process.env.ENV_DOMAIN!;
const site = new BlobStoreWebSite("aws", `s3://web.${domain}`, {
  errorDocument: "404.html",
  files: { dir: "./dist", exclude: ["**/*.map"], prune: true, cacheControl: [{ match: "assets/**", value: "public, max-age=31536000, immutable" }] },
  cors: [{ origins: [`https://web.${domain}`], methods: ["GET", "HEAD"], maxAgeSeconds: 3600 }],
});

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
