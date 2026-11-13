import { FunctionRouter } from "@cloudgear/functions";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const apiDns = new DNS("gandi", "api.example.com", { zone: "example.com" });
const apiCert = new Cert("aws", apiDns);

export async function items() {
  return {};
}
export async function createItem() {
  return {};
}
export async function a() {
  return {};
}
export async function b() {
  return {};
}

const router = new FunctionRouter("aws").url("GET", "/items", items).url("POST", "/items", createItem).url("GET", "/a", a).url("GET", "/b", b);
new CDN("aws", apiCert, { router, freePlan: true });
