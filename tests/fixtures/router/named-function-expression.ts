import { FunctionRouter } from "@cloudgear/functions";

export const d = function inner() {
  return {};
};

new FunctionRouter("aws").url("GET", "/d", d);
