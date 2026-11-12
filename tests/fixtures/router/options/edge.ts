import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const site = new BlobStore("aws", "://my-site");
const dns = new DNS("gandi", "cdn.example.com");
const cert = new Cert("aws", dns, { options: { key_algorithm: "EC_prime256v1" } });
const cdn = new CDN("aws", cert, { bucket: site, options: { price_class: "PriceClass_100", default_root_object: "home.html", web_acl: true } });

export async function f() {
  return {};
}

new FunctionRouter("aws", { cdn }).url("GET", "/f", f);
