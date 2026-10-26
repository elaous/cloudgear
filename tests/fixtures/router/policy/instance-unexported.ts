import { FunctionRouter } from "@cloudgear/functions";

class Api {
  async run() {
    return {};
  }
}

const api = new Api();

new FunctionRouter("aws").url("GET", "/run", api.run);
