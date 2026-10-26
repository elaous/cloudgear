import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const site = new BlobStore("aws", "://my-site", { path: "/web" });
const siteDns = new DNS("gandi", "www.example.com", { zone: "example.com" });
const siteCert = new Cert("aws", siteDns);
const cdn = new CDN("aws", siteCert, { bucket: site });
const apiDns = new DNS("gandi", "api.example.com", { zone: "example.com" });
const apiCert = new Cert("aws", apiDns);

export async function getObject(input: { param: string }) {
  return input;
}
export async function health() {
  return { ok: true };
}
export async function nested(input: { id: string }) {
  return input;
}

new FunctionRouter("aws", { cert: apiCert })
  .url("GET", "/objects/{param}", getObject)
  .url("HEAD", "/objects/{param}", getObject, { name: "headObject" })
  .url("GET", "/health", health)
  .url("GET", "/users/{id}/profile", nested);
