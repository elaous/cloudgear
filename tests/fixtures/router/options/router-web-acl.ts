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

const site = new BlobStore("aws", "://my-site");
const siteDns = new DNS("gandi", "www.example.com", { zone: "example.com" });
const siteCert = new Cert("aws", siteDns);
const router = new FunctionRouter("aws").url("GET", "/items", items);
new CDN("aws", siteCert, { bucket: site });
new CDN("aws", apiCert, { router, webAcl: "arn:aws:wafv2:us-east-1:111122223333:global/webacl/mine/b576f740-7bb3-4e5f-849b-af9d3c2b0c27" });
