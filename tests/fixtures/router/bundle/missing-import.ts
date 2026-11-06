import { FunctionRouter } from "@cloudgear/functions";
import { value } from "./does-not-exist.generated";

export async function api() {
  return { value };
}

new FunctionRouter("aws").url("GET", "/api", api);
