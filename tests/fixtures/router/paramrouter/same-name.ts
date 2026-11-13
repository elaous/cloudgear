import { FunctionRouter, ParamRouter, VercelResponse } from "@cloudgear/functions";

new FunctionRouter("aws")
  .url("*", "/a", new ParamRouter({ "GET /items": { script: "./api/items.ts" } }), { request: true, response: VercelResponse })
  .url("*", "/b", new ParamRouter({ "GET /items": { script: "./api/item.ts" } }), { request: true, response: VercelResponse });
