import { FunctionRouter, VercelResponse } from "@cloudgear/functions";
import { SecretStore } from "@cloudgear/secrets";

const store = new SecretStore("aws");
const env = store.path("/app");

new FunctionRouter("aws").url("*", "/", "./api/index.ts", {
  include: "./dist/index.html",
  request: true,
  response: VercelResponse,
  env: env({ A: "A" }),
});
