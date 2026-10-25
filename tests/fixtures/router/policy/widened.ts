import { BlobStore, permissions, policy } from "@cloudgear/blob";
import { FunctionRouter } from "@cloudgear/functions";

const data = new BlobStore("aws", "://data");

function helper(store: BlobStore) {
  return store.delete("k");
}

export class Api {
  @policy(data, { permissions: [permissions.Get] })
  static async run() {
    return helper(data);
  }
}

new FunctionRouter("aws").url("GET", "/run", Api.run);
