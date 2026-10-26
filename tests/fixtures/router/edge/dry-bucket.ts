import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const site = new BlobStore("aws", "://existing-site"); // cloudgear: dry
const dns = new DNS("aws", "www.example.com");
const cert = new Cert("aws", dns);
const cdn = new CDN("aws", cert, { bucket: site });

export async function f() {
  return {};
}

new FunctionRouter("aws").url("GET", "/f", f);
