import { FunctionRouter } from "@cloudgear/functions";
import { EventBus } from "@cloudgear/events";

const orders = new EventBus("aws", { name: "orders" });

async function emit(bus: EventBus) {
  await bus.publish("order.created", {});
}

export async function charge() {
  await emit(orders);
  return {};
}

new FunctionRouter("aws").url("POST", "/charge", charge);
