import { FunctionRouter } from "@cloudgear/functions";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const apiDns = new DNS("gandi", "api.example.com", { zone: "example.com" });
const apiCert = new Cert("aws", apiDns);

export async function fresh() {
  return {};
}
export async function item({ id }: { id: string }) {
  return { id };
}

const router = new FunctionRouter("aws")
  .url("POST", "/items/new", fresh)
  .url("GET", "/items/{id}", item);
new CDN("aws", apiCert, { router });
