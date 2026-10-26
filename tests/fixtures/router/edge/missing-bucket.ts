import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const dns = new DNS("gandi", "www.example.com");
const cert = new Cert("aws", dns);
// @ts-expect-error bucket is required
const cdn = new CDN("aws", cert, { bucket: undefined });

export async function f() {
  return {};
}

new FunctionRouter("aws").url("GET", "/f", f);
