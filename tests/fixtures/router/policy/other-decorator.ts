import { BlobStore } from "@cloudgear/blob";
import { FunctionRouter } from "@cloudgear/functions";

const data = new BlobStore("aws", "://data");
const tag = (_store: BlobStore) => (_method: unknown, _context: ClassMethodDecoratorContext): void => {};

export class Api {
  @tag(data)
  static async run() {
    return data.get("k");
  }
}

new FunctionRouter("aws").url("GET", "/run", Api.run);
