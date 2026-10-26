import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const apiDns = new DNS("gandi", "api.example.com", { zone: "example.com" });
const apiCert = new Cert("aws", apiDns);

export async function me() {
  return {};
}
export async function health() {
  return {};
}

new FunctionRouter("aws", { cert: apiCert, authenticate: () => null })
  .url("GET", "/health", health, { public: true })
  .url("GET", "/me", me);
