import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

export async function items() {
  return {};
}

const files = new BlobStore("aws", "://my-files");
const dns = new DNS("gandi", "*.example.com", { zone: "example.com" });
const wildcard = new Cert("aws", dns);
new FunctionRouter("aws").url("GET", "/items", items);
new CDN("aws", wildcard, { bucket: files });
