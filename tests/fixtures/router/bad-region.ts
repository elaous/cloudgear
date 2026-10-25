import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const data = new BlobStore("aws", "://data", { region: "Europe" });

export async function f() {
  return data.list();
}

new FunctionRouter("aws").url("GET", "/f", f);
