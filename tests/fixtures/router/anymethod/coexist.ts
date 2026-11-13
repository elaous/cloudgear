import { FunctionRouter } from "@cloudgear/functions";

new FunctionRouter("aws")
  .url("*", "/x", "./api/index.ts", { request: true, name: "any" })
  .url("GET", "/x", "./api/item.ts", { name: "get" });
