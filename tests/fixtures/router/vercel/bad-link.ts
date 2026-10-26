import { FunctionRouter, response } from "@cloudgear/functions";

new FunctionRouter("aws").url("GET", "/v/{slug}", "/api/echo.ts", { include: "linked", request: true, response });
