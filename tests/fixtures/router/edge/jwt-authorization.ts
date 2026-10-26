import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const apiDns = new DNS("gandi", "api.example.com", { zone: "example.com" });
const apiCert = new Cert("aws", apiDns);

export async function me() {
  return {};
}

new FunctionRouter("aws", { cert: apiCert, authenticate: jwtAuth({ issuer: "https://login.example.com" }) })
  .url("GET", "/me", me);
