import { FunctionRouter } from "@cloudgear/functions";
import { BlobStore } from "@cloudgear/blob";

export const store = new BlobStore("aws", "://script-data");

new FunctionRouter("aws")
  .url("GET", "/hello", "./handlers/hello.ts")
  .url("POST", "/items/{id}", "./handlers/save.ts", { name: "saveItem" });
