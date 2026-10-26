import { FunctionRouter, response } from "@cloudgear/functions";

const wanted = true;
new FunctionRouter("aws").url("GET", "/v/{slug}", "/api/echo.ts", { request: wanted, response });
