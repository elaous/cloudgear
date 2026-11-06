import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

export async function items() {
  return {};
}

const dns = new DNS("gandi", "*.example.com", { zone: "example.com" });
const wildcard = new Cert("aws", dns);
new FunctionRouter("aws", { cert: wildcard }).url("GET", "/items", items);
