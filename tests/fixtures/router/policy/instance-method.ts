import { FunctionRouter } from "@cloudgear/functions";

export class Api {
  async run() {
    return {};
  }
}

new FunctionRouter("aws").url("GET", "/run", new Api().run);
