import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const site = new BlobStore("aws", "://my-site");
const dns = new DNS("gandi", "cdn.example.com");
const cert = new Cert("aws", dns);
const cdn = new CDN("aws", dns, { cert, bucket: site });
import { BlobStore as Store } from "@cloudgear/blob";

const privateData = new Store("aws", "://my-site", { path: "private" });

export async function readPrivate() {
  return privateData.getText("k");
}

new FunctionRouter("aws", { cdn }).url("GET", "/private", readPrivate);
