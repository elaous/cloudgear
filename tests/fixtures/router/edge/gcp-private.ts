import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

const site = new BlobStore("gcp", "gs://my-site", { options: { project: "my-proj-123" } });
const dns = new DNS("gandi", "www.example.org");
const cert = new Cert("gcp", dns);
export const cdn = new CDN("gcp", cert, { bucket: site });

export async function f() {
  return {};
}

new FunctionRouter("aws").url("GET", "/f", f);
