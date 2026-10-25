import { FunctionRouter } from "@cloudgear/functions";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const dns = new DNS("gandi", "cdn.example.com");
const cert = new Cert("aws", dns);
// @ts-expect-error bucket is required
const cdn = new CDN("aws", dns, { cert, bucket: undefined });

export async function f() {
  return {};
}

new FunctionRouter("aws", { cdn }).url("GET", "/f", f);
