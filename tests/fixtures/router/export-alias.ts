import { FunctionRouter } from "@cloudgear/functions";

function impl() {
  return {};
}

export { impl as handler };

new FunctionRouter("aws").url("GET", "/h", impl);
