import { FunctionRouter } from "@cloudgear/functions";
import { EventBus } from "@cloudgear/events";

const bus = new EventBus("aws");

export async function notify() {
  return {};
}

const type = process.env.TYPE ?? "x";

new FunctionRouter("aws").url("POST", "/notify", notify, { on: bus.event(type) });
