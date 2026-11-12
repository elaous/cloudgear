import { BlobStore, permissions, policy } from "@cloudgear/blob";
import { FunctionRouter } from "@cloudgear/functions";

const data = new BlobStore("aws", "://data");

export class Api {
  @policy(data, { permissions: [permissions.Get] })
  static async run() {
    return data.client();
  }
}

new FunctionRouter("aws").url("GET", "/run", Api.run);
