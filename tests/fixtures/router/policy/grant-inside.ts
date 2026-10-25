import { BlobStore, grant, permissions, policy } from "@cloudgear/blob";
import { FunctionRouter } from "@cloudgear/functions";

const data = new BlobStore("aws", "://data");

function helper(store: BlobStore) {
  return store.get("k");
}

export class Api {
  @policy(data, { permissions: [permissions.Get, permissions.List] })
  static async run() {
    grant(data, "read");
    return helper(data);
  }
}

new FunctionRouter("aws").url("GET", "/run", Api.run);
