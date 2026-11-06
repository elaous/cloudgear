import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";
import { DNS } from "@cloudgear/dns";
import { CDN, Cert } from "@cloudgear/cdn";

export async function items() {
  return {};
}

const files = new BlobStore("aws", "://my-files");
const web = new BlobStore("aws", "://my-web");
const admin = new BlobStore("aws", "://my-admin");


const filesDns = new DNS("gandi", "files.example.com", { zone: "example.com" });
const filesCert = new Cert("aws", filesDns);
const webDns = new DNS("gandi", "www.example.com", { zone: "example.com" });
const webCert = new Cert("aws", webDns);
const adminDns = new DNS("gandi", "admin.example.com", { zone: "example.com" });
const adminCert = new Cert("aws", adminDns);
const apiDns = new DNS("gandi", "api.example.com", { zone: "example.com" });
const apiCert = new Cert("aws", apiDns);

const router = new FunctionRouter("aws").url("GET", "/items", items);
new CDN("aws", filesCert, { bucket: files });
new CDN("aws", webCert, { bucket: web });
new CDN("aws", adminCert, { bucket: admin });
new CDN("aws", apiCert, { router });
