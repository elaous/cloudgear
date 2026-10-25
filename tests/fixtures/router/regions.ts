import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const eu = new BlobStore("aws", "://eu-data", { region: "eu-west-1" });
const home = new BlobStore("aws", "://home-data");

export async function f() {
  return [await eu.list(), await home.list()];
}

new FunctionRouter("aws", { region: "us-east-2" }).url("GET", "/f", f);
