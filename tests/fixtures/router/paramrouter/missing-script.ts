import { FunctionRouter, ParamRouter, VercelResponse } from "@cloudgear/functions";

new FunctionRouter("aws").url("*", "/", new ParamRouter({ "GET /items": { script: "./api/nope.ts" } }), { request: true, response: VercelResponse });
