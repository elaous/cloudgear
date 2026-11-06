import { FunctionRouter } from "@cloudgear/functions";
import { EventBus } from "@cloudgear/events";

export async function notify() {
  return {};
}

new EventBus("aws");
new FunctionRouter("aws").url("POST", "/notify", notify);
