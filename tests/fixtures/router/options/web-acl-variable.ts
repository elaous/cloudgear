import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const site = new BlobStore("aws", "://my-site");
const dns = new DNS("gandi", "cdn.example.com");
const cert = new Cert("aws", dns, { options: { key_algorithm: "EC_prime256v1" } });
const acl = "arn:aws:wafv2:us-east-1:111122223333:global/webacl/mine/b576f740-7bb3-4e5f-849b-af9d3c2b0c27";
const cdn = new CDN("aws", cert, { bucket: site, webAcl: acl });

export async function f() {
  return {};
}

new FunctionRouter("aws", { cdn }).url("GET", "/f", f);
