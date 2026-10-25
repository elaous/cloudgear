import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const store = new BlobStore("aws", "://things"); // cloudgear: dyr

export async function read() {
  return store.list();
}

new FunctionRouter("aws").url("GET", "/things", read);
