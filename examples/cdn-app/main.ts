import { BlobStore } from "@cloudgear/blob";
import { permissions, policy } from "@cloudgear/core";
import { CDN, Cert } from "@cloudgear/cdn";
import { DNS } from "@cloudgear/dns";
import { FunctionRouter } from "@cloudgear/functions";

const bucket = new BlobStore("aws", "://mybucket", { path: "/img-cache/" });

export class Local {
  @policy(bucket, { permissions: [permissions.Get, permissions.Put, permissions.List] })
  static async getObjects({ param }: { param: string }) {
    const cached = await bucket.getText(param);
    if (cached !== null) return { key: param, body: cached };
    await bucket.put(param, `generated for ${param}`);
    return { key: param, keys: await bucket.list() };
  }
}

const siteDns = new DNS("gandi", "www.example.com", { zone: "example.com" });
const siteCert = new Cert("aws", siteDns);
const cdn = new CDN("aws", siteCert, { bucket });

const apiDns = new DNS("gandi", "api.example.com", { zone: "example.com" });
const apiCert = new Cert("aws", apiDns);

const router = new FunctionRouter("aws", { cert: apiCert, authenticated: "iam" });
router.url("GET", "/objects/{param}", Local.getObjects, { name: "getObjects", public: true });
router.listen();
