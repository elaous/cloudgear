import { FunctionRouter, response } from "@cloudgear/functions";

new FunctionRouter("aws").url("GET", "/v/{slug}", "/api/echo.ts", { include: ".cloudgear/build", request: true, response });
