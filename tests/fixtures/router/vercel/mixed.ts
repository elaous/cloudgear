import { FunctionRouter, response } from "@cloudgear/functions";

new FunctionRouter("aws")
  .url("GET", "/v/{slug}", "/api/echo.ts", { request: true, response })
  .url("POST", "/v/{slug}", "/api/echo.ts", { response });
