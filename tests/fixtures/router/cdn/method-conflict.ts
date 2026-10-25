import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const site = new BlobStore("aws", "://my-site");
const dns = new DNS("gandi", "cdn.example.com");
const cert = new Cert("aws", dns);
const cdn = new CDN("aws", dns, { cert, bucket: site });

export async function getFoo(input: { param: string }) {
  return input;
}
export async function createFoo(input: { param: string }) {
  return input;
}

new FunctionRouter("aws", { cdn }).url("GET", "/foo/{param}", getFoo).url("POST", "/foo/{param}", createFoo);
