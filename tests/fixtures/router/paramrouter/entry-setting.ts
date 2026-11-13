import { FunctionRouter, ParamRouter, VercelResponse } from "@cloudgear/functions";

new FunctionRouter("aws").url(
  "*",
  "/",
  new ParamRouter({
    // @ts-expect-error request belongs to the mount
    "GET /items": { script: "./api/items.ts", request: true },
  }),
  { request: true, response: VercelResponse },
);
