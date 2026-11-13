import { FunctionRouter, ParamRouter, VercelResponse } from "@cloudgear/functions";

new FunctionRouter("aws").url("*", "/", new ParamRouter({ "GET /store": { script: "./api/store.ts" } }, { name: "api" }), { request: true, response: VercelResponse });
