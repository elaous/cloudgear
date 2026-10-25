import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const first = new BlobStore("aws", "://a-b");
const second = new BlobStore("aws", "://a.b");

export async function both() {
  return [await first.list(), await second.list()];
}

new FunctionRouter("aws").add("GET", "/both", both);
