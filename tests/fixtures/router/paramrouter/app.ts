import { FunctionRouter, ParamRouter, VercelResponse } from "@cloudgear/functions";

new FunctionRouter("aws").url(
  "*",
  "/",
  new ParamRouter(
    {
      "GET /items": { script: "./api/items.ts" },
      "GET /items/{id}": { script: "./api/item.ts" },
      "POST /items": { script: "./api/create.ts" },
    },
    { name: "api" },
  ),
  { request: true, response: VercelResponse },
);
