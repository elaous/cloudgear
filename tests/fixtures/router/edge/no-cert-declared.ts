import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const cert = { domain: "api.example.com" };

export async function f() {
  return {};
}

new FunctionRouter("aws", { cert }).url("GET", "/f", f);
