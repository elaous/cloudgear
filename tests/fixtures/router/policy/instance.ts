import { BlobStore, permissions, policy } from "@cloudgear/blob";
import { FunctionRouter } from "@cloudgear/functions";

const data = new BlobStore("aws", "://data");

class Api {
  constructor(private readonly store: BlobStore, private readonly greeting: string) {}

  @policy(data, { permissions: [permissions.Get] })
  async read({ key }: { key: string }) {
    return { greeting: this.greeting, found: (await this.store.getText(key)) !== null };
  }
}

export const api = new Api(data, "hello");

new FunctionRouter("aws").url("GET", "/read", api.read);
