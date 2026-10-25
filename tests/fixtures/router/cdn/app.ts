import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const site = new BlobStore("aws", "://my-site", { path: "/web" });
const dns = new DNS("gandi", "cdn.example.com", { zone: "example.com" });
const cert = new Cert("aws", dns);
const cdn = new CDN("aws", dns, { cert, bucket: site });

export async function getObject(input: { param: string }) {
  return input;
}
export async function putObject(input: { param: string }) {
  return input;
}
export async function health() {
  return { ok: true };
}
export async function nested(input: { id: string }) {
  return input;
}

new FunctionRouter("aws", { cdn })
  .url("GET", "/objects/{param}", getObject)
  .url("HEAD", "/objects/{param}", getObject, { name: "headObject" })
  .url("PUT", "/objects/{param}", getObject, { name: "putObjectViaGet" })
  .url("GET", "/health", health)
  .url("GET", "/users/{id}/profile", nested);
