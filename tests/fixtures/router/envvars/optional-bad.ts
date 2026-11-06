import { FunctionRouter } from "@cloudgear/functions";

export async function f() {
  return {};
}

new FunctionRouter("aws", { optionalEnv: ["A B"] }).url("GET", "/f", f);
