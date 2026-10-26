import { FunctionRouter, response } from "@cloudgear/functions";

new FunctionRouter("aws").url("GET", "/v/{slug}", "/api/v/[slug].ts", {
  include: "dist/index.html",
  request: true,
  response,
});
