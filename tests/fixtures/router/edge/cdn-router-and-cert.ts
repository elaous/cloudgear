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

const otherDns = new DNS("gandi", "edge.example.com", { zone: "example.com" });
const otherCert = new Cert("aws", otherDns);
const router = new FunctionRouter("aws", { cert: apiCert }).url("GET", "/items", items);
new CDN("aws", otherCert, { router });
