import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const apiDns = new DNS("gandi", "api.example.com", { zone: "example.com" });
const apiCert = new Cert("aws", apiDns);

export async function items() {
  return {};
}
export async function item({ id }: { id: string }) {
  return { id };
}
export async function createItem() {
  return {};
}

const router = new FunctionRouter("aws")
  .url("GET", "/items", items)
  .url("POST", "/items", createItem);
new CDN("aws", apiCert, { router });
