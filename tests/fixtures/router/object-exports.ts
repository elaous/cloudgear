import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

const store = new BlobStore("aws", "://objects", { path: "/img-cache/" });

export const local = {
  prefix: "obj",
  async getObjects(input: { param: string }) {
    return { key: `${this.prefix}/${input.param}`, body: await store.getText(input.param) };
  },
  put: async (input: { param: string }) => store.put(input.param, "x"),
};

new FunctionRouter("aws")
  .url("GET", "/objects/{param}", local.getObjects)
  .url("PUT", "/objects/{param}", local.put, { name: "putObject" });
