import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

export async function items() {
  return {};
}

const files = new BlobStore("aws", "://my-files");
const wildDns = new DNS("gandi", "*.example.com", { zone: "example.com" });
const apiDns = new DNS("gandi", "api.example.com", { zone: "example.com" });
const wildcard = new Cert("aws", wildDns);
const apiCert = new Cert("aws", apiDns);

new FunctionRouter("aws", { cert: apiCert }).url("GET", "/items", items);
new CDN("aws", wildcard, { bucket: files, domain: "api.example.com" });
