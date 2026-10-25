import { BlobStore, permissions, policy } from "@cloudgear/blob";
import { FunctionRouter } from "@cloudgear/functions";

const data = new BlobStore("aws", "://data");
const other = { not: "a store" };

export class Api {
  @policy(data, { permissions: [permissions.Get, permissions.Delete] })
  static async run() {
    
    return {};
  }
}

new FunctionRouter("aws").url("GET", "/run", Api.run);
