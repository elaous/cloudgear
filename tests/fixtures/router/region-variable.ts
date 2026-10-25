import { FunctionRouter } from "@cloudgear/functions";

const region = "eu-west-1";

export async function f() {
  return {};
}

new FunctionRouter("aws", { region }).url("GET", "/f", f);
