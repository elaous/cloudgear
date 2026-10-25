import { FunctionRouter } from "@cloudgear/functions";

export async function f() {
  return {};
}

new FunctionRouter("aws", { functionOptions: { __proto__: "x" } }).url("GET", "/f", f);
