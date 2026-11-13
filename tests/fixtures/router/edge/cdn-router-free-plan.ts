import { FunctionRouter } from "@cloudgear/functions";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const apiDns = new DNS("gandi", "api.example.com", { zone: "example.com" });
const apiCert = new Cert("aws", apiDns);

export async function a() {
  return {};
}
export async function b() {
  return {};
}
export async function c() {
  return {};
}

const router = new FunctionRouter("aws").url("GET", "/a", a).url("GET", "/b", b).url("POST", "/c", c);
new CDN("aws", apiCert, { router, freePlan: true });
