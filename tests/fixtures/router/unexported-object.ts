import { FunctionRouter } from "@cloudgear/functions";

const hidden = {
  run() {
    return {};
  },
};

new FunctionRouter("aws").url("GET", "/run", hidden.run);
