import { FunctionRouter } from "@cloudgear/functions";

declare function compute(): string;
const region = compute();

export async function f() {
  return {};
}

new FunctionRouter("aws", { region }).url("GET", "/f", f);
