import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const images = new BlobStore("aws", "://shared", { path: "images" });
const docs = new BlobStore("aws", "://shared", { path: "docs/" });

export async function readImage() {
  return images.getText("a");
}

export async function writeDoc() {
  return docs.put("b", "x");
}

new FunctionRouter("aws").url("GET", "/image", readImage).url("PUT", "/doc", writeDoc);
