import { FunctionRouter, ParamRouter, VercelResponse, cron } from "@cloudgear/functions";

new FunctionRouter("aws").url("*", "/", new ParamRouter({ "GET /items": { script: "./api/items.ts" } }), { request: true, response: VercelResponse, schedule: cron`0 3 * * *` });
