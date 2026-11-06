import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

export async function items() {
  return {};
}

const one = new BlobStore("aws", "://one");
const two = new BlobStore("aws", "://two");
const dns = new DNS("gandi", "*.example.com", { zone: "example.com" });
const wildcard = new Cert("aws", dns);
new FunctionRouter("aws").url("GET", "/items", items);
new CDN("aws", wildcard, { bucket: one, domain: "www.example.com" });
new CDN("aws", wildcard, { bucket: two, domain: "www.example.com" });
