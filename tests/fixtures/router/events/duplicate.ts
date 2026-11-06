import { FunctionRouter } from "@cloudgear/functions";
import { EventBus } from "@cloudgear/events";

const one = new EventBus("aws", { name: "orders" });
const two = new EventBus("aws", { name: "orders" });

export async function charge() {
  await one.publish("x", {});
  await two.publish("x", {});
  return {};
}

new FunctionRouter("aws").url("POST", "/charge", charge);
