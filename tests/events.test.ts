import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHandler } from "@cloudgear/functions/drivers/aws";
import { EventBus, on } from "@cloudgear/events";
import { memoryEvents, resetMemoryEvents } from "@cloudgear/events/drivers/memory";

const prior = process.env.CLOUDGEAR_EVENTS_DRIVER;
beforeEach(() => {
  process.env.CLOUDGEAR_EVENTS_DRIVER = "memory";
  resetMemoryEvents();
});
afterEach(() => {
  if (prior === undefined) delete process.env.CLOUDGEAR_EVENTS_DRIVER;
  else process.env.CLOUDGEAR_EVENTS_DRIVER = prior;
});

describe("EventBus", () => {
  test("is the default bus unless named", () => {
    expect(new EventBus("aws").name).toBe("default");
    expect(new EventBus("aws", { name: "orders" }).name).toBe("orders");
  });

  test("refuses other providers, the name default and bad names", () => {
    expect(() => new EventBus("gcp" as never)).toThrow(/not supported yet/);
    expect(() => new EventBus("aws", { name: "default" })).toThrow(/default bus/);
    expect(() => new EventBus("aws", { name: "a b" })).toThrow(/Invalid bus name/);
  });

  test("publishes to the bus found in the environment, else by name", async () => {
    const bus = new EventBus("aws", { name: "orders" });
    await bus.publish("order.created", { id: 1 });
    process.env.CLOUDGEAR_EVENTBUS_ORDERS = "app-orders";
    try {
      await bus.publish("order.paid", { id: 1 }, { source: "shop" });
    } finally {
      delete process.env.CLOUDGEAR_EVENTBUS_ORDERS;
    }
    expect(memoryEvents().map((e) => [e.bus, e.source, e.type])).toEqual([
      ["orders", "cloudgear", "order.created"],
      ["app-orders", "shop", "order.paid"],
    ]);
  });

  test("returns the id the driver gave", async () => {
    expect(await new EventBus("aws").publish("x", {})).toBe("memory-1");
  });

  test("an event type and a source are validated; aws. sources are reserved", async () => {
    const bus = new EventBus("aws");
    await expect(bus.publish("bad;type", {})).rejects.toThrow(/Invalid event type/);
    await expect(bus.publish("ok", {}, { source: "aws.s3" })).rejects.toThrow(/reserved/);
    expect(() => bus.event({ type: "ok", source: "aws.s3" })).toThrow(/reserved/);
  });

  test("an event trigger names its bus, type and source", () => {
    const bus = new EventBus("aws");
    expect(bus.event("order.created")).toEqual({ kind: "event", bus, type: "order.created" });
    expect(bus.event({ type: "order.created", source: "shop" }).source).toBe("shop");
  });

  test("the variable name of a bus is upper snake case", () => {
    expect(EventBus.envVarFor("my-orders.v2")).toBe("CLOUDGEAR_EVENTBUS_MY_ORDERS_V2");
  });

  test("on() leaves the method alone", () => {
    class Jobs {
      @on(new EventBus("aws").event("x"))
      static run() {
        return 1;
      }
    }
    expect(Jobs.run()).toBe(1);
  });
});

describe("handler for bus events", () => {
  const busEvent = (over: Record<string, unknown> = {}) => ({ id: "e1", source: "shop", "detail-type": "order.created", time: "2026-01-01T00:00:00Z", detail: { id: 7 }, ...over });

  test("the detail is the input and the event is in the context", async () => {
    const seen: unknown[] = [];
    const handler = createHandler(async (input: unknown, context: unknown) => void seen.push(input, context), []);
    expect((await handler(busEvent() as never)).statusCode).toBe(200);
    expect(seen).toEqual([{ id: 7 }, { event: { id: "e1", type: "order.created", source: "shop", time: "2026-01-01T00:00:00Z" } }]);
  });

  test("a detail that is not an object arrives as { detail }", async () => {
    const seen: unknown[] = [];
    const handler = createHandler(async (input: unknown) => void seen.push(input), []);
    await handler(busEvent({ detail: [1, 2] }) as never);
    await handler(busEvent({ detail: "text" }) as never);
    expect(seen).toEqual([{ detail: [1, 2] }, { detail: "text" }]);
  });

  test("a failing run is thrown so Lambda retries it", async () => {
    const handler = createHandler(async () => {
      throw new Error("boom");
    }, []);
    const quiet = console.error;
    console.error = () => {};
    try {
      await expect(handler(busEvent() as never)).rejects.toThrow(/Event run failed with status 500/);
    } finally {
      console.error = quiet;
    }
  });

  test("a scheduled event is still a schedule, not a bus event", async () => {
    const seen: unknown[] = [];
    const handler = createHandler(async (input: unknown) => void seen.push(input), []);
    await handler({ source: "aws.events", "detail-type": "Scheduled Event", time: "t", resources: ["rule"] } as never);
    expect(seen).toEqual([{ scheduledTime: "t", rule: "rule" }]);
  });

  test("preparation runs before the event", async () => {
    const order: string[] = [];
    const handler = createHandler(async () => void order.push("run"), [], { prepare: async () => void order.push("prepare") });
    await handler(busEvent() as never);
    expect(order).toEqual(["prepare", "run"]);
  });
});
