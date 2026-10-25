import { BlobStore, permissions, policy } from "@cloudgear/blob";
import { FunctionRouter } from "@cloudgear/functions";

const images = new BlobStore("aws", "://data", { path: "images" });
const docs = new BlobStore("aws", "://data", { path: "docs" });

export class Api {
  @policy(images, { permissions: [permissions.Get] })
  @policy(docs, { permissions: [permissions.Put] })
  static async run() {
    await docs.put("k", "v");
    return images.get("k");
  }
}

new FunctionRouter("aws").url("GET", "/run", Api.run);
