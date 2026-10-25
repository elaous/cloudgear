import { BlobStore, permissions, policy } from "@cloudgear/blob";
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

const dns = new DNS("gandi", "cdn.example.com");
const cert = new Cert("aws", dns);
const cdn = new CDN("aws", dns, { cert, bucket });

const router = new FunctionRouter("aws", { cdn, authenticated: "iam" });
router.url("GET", "/objects/{param}", Local.getObjects, { name: "getObjects", public: true });
router.listen();
