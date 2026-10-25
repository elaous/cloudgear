import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const store = new BlobStore("aws", "://props");

export const svc = {
  store,
  async viaThis() {
    return this.store.getText("k");
  },
  async viaName() {
    return svc.store.getText("k");
  },
};

new FunctionRouter("aws").url("GET", "/a", svc.viaThis).url("GET", "/b", svc.viaName);
