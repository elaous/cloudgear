import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const dns = new DNS("gandi", "api.example.com");
const cert = new Cert("aws", dns, { region: "eu-central-1", options: { key_algorithm: "EC_prime256v1" } });

export async function f() {
  return {};
}

new FunctionRouter("aws", { cert, region: "eu-central-1" }).url("GET", "/f", f);
