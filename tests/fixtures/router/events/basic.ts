import { FunctionRouter } from "@cloudgear/functions";
import { EventBus, on } from "@cloudgear/events";

const orders = new EventBus("aws", { name: "orders" });

export async function charge({ id }: { id: string }) {
  await orders.publish("order.created", { id });
  return { id };
}

export async function receipt() {
  return {};
}

export class Jobs {
  @on(orders.event({ type: "order.created", source: "shop" }))
  static async onCreated(order: { id: string }) {
    return order;
  }
}

new FunctionRouter("aws").url("POST", "/charge", charge).url("POST", "/receipt", receipt, { on: orders.event("order.paid") });
