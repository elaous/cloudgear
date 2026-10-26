import { FunctionRouter } from "@cloudgear/functions";

class Api {
  async read() {
    return {};
  }
}

export const api = new Api();
const alias = api;

new FunctionRouter("aws").url("GET", "/read", alias.read);
