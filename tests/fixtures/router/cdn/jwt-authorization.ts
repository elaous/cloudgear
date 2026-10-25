import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const site = new BlobStore("aws", "://my-site");
const dns = new DNS("gandi", "cdn.example.com");
const cert = new Cert("aws", dns);
const cdn = new CDN("aws", dns, { cert, bucket: site });

export async function me() {
  return {};
}
export async function health() {
  return {};
}
export async function both() {
  return {};
}

new FunctionRouter("aws", { cdn, authenticate: jwtAuth({ issuer: "https://login.example.com" }) })
  .url("GET", "/me", me);
