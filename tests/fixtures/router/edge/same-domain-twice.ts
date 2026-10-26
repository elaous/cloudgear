import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const firstDns = new DNS("gandi", "api.example.com");
const secondDns = new DNS("aws", "api.example.com");
const first = new Cert("aws", firstDns);
const second = new Cert("aws", secondDns);

export async function f() {
  return {};
}

new FunctionRouter("aws", { cert: first }).url("GET", "/f", f);
