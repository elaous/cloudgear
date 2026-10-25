import { FunctionRouter } from "@cloudgear/functions";

function hidden() {
  return {};
}

new FunctionRouter("aws").add("GET", "/hidden", hidden);
