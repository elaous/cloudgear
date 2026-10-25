import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore, grant } from "@cloudgear/blob";

const store = new BlobStore("aws", "://granted");

class Repo {
  constructor(private readonly blobs: BlobStore) {}
  read() {
    return this.blobs.getText("k");
  }
}

const repo = new Repo(store);

export async function viaRepo() {
  grant(store, "read");
  return repo.read();
}

export async function widened() {
  return repo.read();
}

new FunctionRouter("aws").url("GET", "/narrow", viaRepo).url("GET", "/wide", widened);
