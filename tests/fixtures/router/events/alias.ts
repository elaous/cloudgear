import { FunctionRouter } from "@cloudgear/functions";
import { EventBus } from "@cloudgear/events";

const orders = new EventBus("aws", { name: "orders" });
const alias = orders;

export async function charge() {
  await alias.publish("order.created", {});
  return {};
}

new FunctionRouter("aws").url("POST", "/charge", charge);
