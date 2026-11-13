import { FunctionRouter, VercelResponse } from "@cloudgear/functions";

new FunctionRouter("aws").url("GET", "/api", "./lazy-script.ts", { request: true, response: VercelResponse });
