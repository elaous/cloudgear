import { FunctionRouter } from "@cloudgear/functions";
import { usedHelper } from "./lazy-sibling-lib.ts";

export async function api() {
  return usedHelper();
}

new FunctionRouter("aws").url("GET", "/api", api);
