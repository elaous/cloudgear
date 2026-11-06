import { FunctionRouter } from "@cloudgear/functions";
import { EventBus } from "@cloudgear/events";

const a = new EventBus("aws", { name: "a.b" });
const b = new EventBus("aws", { name: "a-b" });

export async function charge() {
  await a.publish("x", {});
  await b.publish("x", {});
  return {};
}

new FunctionRouter("aws").url("POST", "/charge", charge);
