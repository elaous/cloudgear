import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const dns = new DNS("gandi", "example.com");
const cert = new Cert("aws", dns);

export async function f() {
  return {};
}

new FunctionRouter("aws", { cert }).url("GET", "/f", f);
