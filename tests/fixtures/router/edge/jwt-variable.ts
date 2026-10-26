import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const apiDns = new DNS("gandi", "api.example.com", { zone: "example.com" });
const apiCert = new Cert("aws", apiDns);

const issuer = "https://x.example.com";
export async function me() {
  return {};
}

new FunctionRouter("aws", { cert: apiCert, authenticate: jwtAuth({ issuer }) })
  .url("GET", "/me", me);
