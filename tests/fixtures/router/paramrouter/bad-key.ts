import { FunctionRouter, ParamRouter, VercelResponse } from "@cloudgear/functions";

new FunctionRouter("aws").url("*", "/", new ParamRouter({ "FETCH /items": { script: "./api/items.ts" } }), { request: true, response: VercelResponse });
