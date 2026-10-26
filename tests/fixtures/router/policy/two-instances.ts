import { FunctionRouter } from "@cloudgear/functions";

class Api {
  async read() {
    return {};
  }
}

export const a = new Api();
export const b = new Api();

new FunctionRouter("aws").url("GET", "/a", a.read).url("GET", "/b", b.read, { name: "readB" });
