import { FunctionRouter } from "@cloudgear/functions";

export async function notify() {
  return {};
}

new FunctionRouter("aws").url("POST", "/notify", notify, { on: "order.created" });
