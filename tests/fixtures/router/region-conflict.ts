import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const a = new BlobStore("aws", "://shared", { region: "eu-west-1", path: "a" });
const b = new BlobStore("aws", "://shared", { region: "us-east-1", path: "b" });

export async function f() {
  return [await a.list(), await b.list()];
}

new FunctionRouter("aws").url("GET", "/f", f);
