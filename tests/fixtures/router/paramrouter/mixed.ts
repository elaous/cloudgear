import { FunctionRouter, ParamRouter, VercelResponse } from "@cloudgear/functions";

export async function health() {
  return { ok: true };
}

new FunctionRouter("aws")
  .url("GET", "/health", health)
  .url("*", "/v1", new ParamRouter({ "GET /items": { script: "./api/items.ts" }, "POST /items": { script: "./api/create.ts", include: "./api/item.ts" } }), { request: true, response: VercelResponse });
