import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

export async function items() {
  return {};
}

const files = new BlobStore("aws", "://my-files");
const dns = new DNS("gandi", "*.example.com", { zone: "example.com" });
const wildcard = new Cert("aws", dns, { region: "eu-west-1" });

new FunctionRouter("aws").url("GET", "/items", items);
new CDN("aws", wildcard, { bucket: files, domain: "files.example.com" });
