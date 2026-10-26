import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const apiDns = new DNS("gandi", "api.example.com", { zone: "example.com" });
const apiCert = new Cert("aws", apiDns);

export async function both() {
  return {};
}

new FunctionRouter("aws", { cert: apiCert, authenticate: jwtAuth({ issuer: "https://login.example.com", audience: ["app", "web"], header: "X-Auth-Token", clockToleranceSeconds: 5 }) })
  .url("GET", "/a", both)
  .url("GET", "/b", both, { name: "bothPublic", public: true });
