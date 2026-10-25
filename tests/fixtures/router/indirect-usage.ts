import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const store = new BlobStore("aws", "://indirect");
const logs = new BlobStore("aws", "://logs");
const alias = store;
const repo = {
  async save() {
    await logs.delete("old");
  },
};

class Service {
  async put() {
    await store.put("k", "v");
  }
}

await store.put("boot", "cold start");

export async function viaClass() {
  return new Service().put();
}

export async function viaObject() {
  return repo.save();
}

export async function viaAlias() {
  return alias.list();
}

export async function inherited() {
  return { text: store.toString(), own: store.hasOwnProperty("x") };
}

new FunctionRouter("aws")
  .add("POST", "/class", viaClass)
  .add("POST", "/object", viaObject)
  .add("GET", "/alias", viaAlias)
  .add("GET", "/inherited", inherited);
