import { FunctionRouter, ParamRouter } from "@cloudgear/functions";

new FunctionRouter("aws").url("*", "/", new ParamRouter({ "GET /items": { script: "./api/items.ts" } }));
