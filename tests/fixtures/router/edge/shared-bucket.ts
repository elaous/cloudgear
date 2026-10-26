import { FunctionRouter, jwtAuth } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const site = new BlobStore("aws", "://my-site");
const siteDns = new DNS("gandi", "www.example.com", { zone: "example.com" });
const siteCert = new Cert("aws", siteDns);
const cdn = new CDN("aws", siteCert, { bucket: site });

import { BlobStore as Store } from "@cloudgear/blob";
const privateData = new Store("aws", "://my-site", { path: "private" });

export async function readPrivate() {
  return privateData.getText("k");
}

new FunctionRouter("aws").url("GET", "/private", readPrivate);
