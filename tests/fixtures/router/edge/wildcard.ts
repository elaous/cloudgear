import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

export async function items() {
  return {};
}

const files = new BlobStore("aws", "://my-files");
const web = new BlobStore("aws", "://my-web");
const dns = new DNS("gandi", "*.example.com", { zone: "example.com" });
const wildcard = new Cert("aws", dns);
const router = new FunctionRouter("aws").url("GET", "/items", items);
new CDN("aws", wildcard, { bucket: files, domain: "files.example.com" });
new CDN("aws", wildcard, { bucket: web, domain: "www.example.com" });
new CDN("aws", wildcard, { router, domain: "api.example.com" });
