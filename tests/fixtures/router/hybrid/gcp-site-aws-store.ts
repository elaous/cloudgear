import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const site = new BlobStore("aws", "://site");
const dns = new DNS("gandi", "www.example.com");
const cert = new Cert("aws", dns);
const cdn = new CDN("aws", cert, { bucket: site });

export async function f() {
  return {};
}

new FunctionRouter("gcp").url("GET", "/f", f);
