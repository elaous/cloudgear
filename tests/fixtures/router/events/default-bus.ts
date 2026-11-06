import { FunctionRouter } from "@cloudgear/functions";
import { EventBus } from "@cloudgear/events";

const bus = new EventBus("aws");

export async function notify() {
  return {};
}

new FunctionRouter("aws").url("POST", "/notify", notify, { on: [bus.event("a"), bus.event("b")] });
