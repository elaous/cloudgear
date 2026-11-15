import { FunctionRouter } from "@cloudgear/functions";
import { DNS } from "@cloudgear/dns";
import { BlobStore } from "@cloudgear/blob";
import { Cert, CDN } from "@cloudgear/cdn";

const domain = process.env.ENV_DOMAIN!;
const zone = process.env["ENV_ZONE"] ?? "example.com";

const dns = new DNS("gandi", `web.${domain}`, { zone });
const cert = new Cert("aws", dns);
const bucket = new BlobStore("aws", "s3://web." + domain);
const cdn = new CDN("aws", cert, { bucket });
await cdn.url();

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
