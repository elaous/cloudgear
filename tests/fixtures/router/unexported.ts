import { FunctionRouter } from "@cloudgear/functions";

function hidden() {
  return {};
}

new FunctionRouter("aws").url("GET", "/hidden", hidden);
