import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeConfig, encodeConfig, type CloudgearConfig } from "../src/config/schema";
import { eventPattern } from "../src/deploy/aws/eventbus";
import { plan } from "../src/deploy/plan";
import { generate } from "../src/generate";
import { applyAll, baseConfig, emptyState, fakeAws, fn } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "events", `${name}.ts`);
const generated = async (name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "events-"));
  const configPath = path.join(dir, "c.prototxt");
  const { config, warnings } = await generate({ entry: fixture(name), configPath, buildDir: path.join(dir, "b"), project: "app" });
  return { config, warnings, text: fs.readFileSync(configPath, "utf8") };
};

describe("analysis", () => {
  test("a named bus becomes a resource, with triggers from options and decorators", async () => {
    const { config } = await generated("basic");
    expect(config.resource.map((r) => [r.name, r.type, r.physical_name, r.dry])).toEqual([["bus.orders", "@aws.EventBus", "app-orders", false]]);
    const byName = Object.fromEntries(config.function.map((f) => [f.name, f]));
    expect(byName.receipt!.event).toEqual([{ bus: "bus.orders", type: "order.paid" }]);
    expect(byName["Jobs-onCreated"]!.event).toEqual([{ bus: "bus.orders", type: "order.created", source: "shop" }]);
    expect(byName["Jobs-onCreated"]!.route).toEqual([]);
  });

  test("a function that publishes gets PutEvents on the bus and its name in the environment", async () => {
    const { config } = await generated("basic");
    const charge = config.function.find((f) => f.name === "charge")!;
    expect(charge.permission).toEqual([{ resource: "bus.orders", path: "", action: ["events:PutEvents"] }]);
    expect(charge.env).toEqual([{ key: "CLOUDGEAR_EVENTBUS_ORDERS", value_from: "bus.orders" }]);
    expect(charge.event).toBeUndefined();
  });

  test("the default bus is dry and a function can have several triggers", async () => {
    const { config } = await generated("default-bus");
    expect(config.resource.map((r) => [r.physical_name, r.dry])).toEqual([["default", true]]);
    expect(config.function[0]!.event).toEqual([
      { bus: "bus.default", type: "a" },
      { bus: "bus.default", type: "b" },
    ]);
  });

  test("an app can have only event-triggered functions", async () => {
    const { config } = await generated("only-events");
    expect(config.function.map((f) => [f.name, f.route.length])).toEqual([["Worker-run", 0]]);
  });

  test.each([
    ["inline-bus", /assign new EventBus/],
    ["bad-trigger", /event type must be a string literal/],
    ["not-a-trigger", /an event trigger must be bus\.event/],
    ["reserved-source", /reserved/],
  ])("%s is rejected", async (name, message) => {
    await expect(generated(name)).rejects.toThrow(message);
  });

  test("a bus reached through an alias is traced", async () => {
    const { config } = await generated("alias");
    expect(config.function[0]!.permission).toEqual([{ resource: "bus.orders", path: "", action: ["events:PutEvents"] }]);
  });

  test("a bus passed as a value is warned about", async () => {
    const { warnings } = await generated("as-value");
    expect(warnings.some((w) => /used as a value/.test(w))).toBe(true);
  });

  test("a bus declared twice is rejected", async () => {
    await expect(generated("duplicate")).rejects.toThrow(/declare each bus once/);
  });

  test("buses that deploy under one name are rejected", async () => {
    await expect(generated("collide")).rejects.toThrow(/both deploy as "app-a-b"/);
  });

  test("a function that handles events of a bus and publishes to it is warned about", async () => {
    const { warnings } = await generated("loop");
    expect(warnings.some((w) => /never publishes the event type it handles/.test(w))).toBe(true);
  });

  test("the config round-trips", async () => {
    const { config } = await generated("basic");
    expect(decodeConfig(encodeConfig(config)).function.map((f) => f.event)).toEqual(config.function.map((f) => f.event));
  });
});

describe("deploying", () => {
  const rule = { bus: "bus.orders", type: "order.paid" };
  const app = (over: Partial<CloudgearConfig> = {}): CloudgearConfig =>
    baseConfig({
      resource: [{ name: "bus.orders", type: "@aws.EventBus", physical_name: "app-orders", dry: false, source: "a.ts:1" }],
      function: [
        fn({ name: "pay", physical_name: "app-pay", permission: [], env: [], route: [{ method: "POST", path: "/pay", name: "pay" }], event: [rule] }),
        fn({
          name: "charge",
          physical_name: "app-charge",
          permission: [{ resource: "bus.orders", path: "", action: ["events:PutEvents"] }],
          env: [{ key: "CLOUDGEAR_EVENTBUS_ORDERS", value_from: "bus.orders" }],
          route: [{ method: "POST", path: "/charge", name: "charge" }],
        }),
      ],
      ...over,
    });
  const aws = () => fakeAws({ CreateEventBusCommand: (input) => ({ EventBusArn: `arn:aws:events:eu-west-1:1:event-bus/${input.Name}` }) });

  test("the pattern matches the type, and the source when given", () => {
    expect(JSON.parse(eventPattern({ event_type: "a.b", source: "" }))).toEqual({ "detail-type": ["a.b"] });
    expect(JSON.parse(eventPattern({ event_type: "a.b", source: "shop" }))).toEqual({ "detail-type": ["a.b"], source: ["shop"] });
  });

  test("the bus comes first, then the function, then the rule that targets it", async () => {
    const calls = await applyAll(app(), emptyState(), aws());
    const names = calls.names();
    expect(names.indexOf("CreateEventBusCommand")).toBeLessThan(names.indexOf("CreateFunctionCommand"));
    expect(names.indexOf("CreateFunctionCommand")).toBeLessThan(names.indexOf("PutRuleCommand"));
    expect(calls.of("CreateEventBusCommand")).toEqual([{ Name: "app-orders" }]);
    const [putRule] = calls.of("PutRuleCommand");
    expect(putRule).toMatchObject({ EventBusName: "app-orders", State: "ENABLED" });
    expect(JSON.parse(putRule.EventPattern)).toEqual({ "detail-type": ["order.paid"] });
    expect(calls.of("PutTargetsCommand")[0]).toMatchObject({ EventBusName: "app-orders", Targets: [{ Id: "cloudgear" }] });
    expect(calls.of("AddPermissionCommand").find((p) => p.Principal === "events.amazonaws.com")).toMatchObject({ FunctionName: "app-pay" });
  });

  test("a publisher is allowed PutEvents on exactly that bus and finds its name in the environment", async () => {
    const calls = await applyAll(app(), emptyState(), aws());
    const policies = calls.of("PutRolePolicyCommand").map((p) => JSON.parse(p.PolicyDocument));
    const statements = policies.flatMap((p) => p.Statement);
    expect(statements).toEqual([{ Effect: "Allow", Action: ["events:PutEvents"], Resource: "arn:aws:events:eu-west-1:1:event-bus/app-orders" }]);
    const charge = calls.of("CreateFunctionCommand").find((c) => c.FunctionName === "app-charge");
    expect(charge.Environment.Variables.CLOUDGEAR_EVENTBUS_ORDERS).toBe("app-orders");
  });

  test("the default bus is never created or deleted, and its rules omit EventBusName", async () => {
    const config = app({ resource: [{ name: "bus.orders", type: "@aws.EventBus", physical_name: "default", dry: true, source: "a.ts:1" }] });
    const state = emptyState();
    const calls = await applyAll(config, state, aws());
    expect(calls.of("CreateEventBusCommand")).toEqual([]);
    expect(calls.of("PutRuleCommand")[0].EventBusName).toBeUndefined();
    const removal = plan(baseConfig({ resource: [], function: [] }), state);
    expect(removal.some((a) => a.op === "delete" && a.type === "@aws.EventBus")).toBe(false);
  });

  test("an unchanged app plans nothing and a changed pattern updates the rule", async () => {
    const state = emptyState();
    await applyAll(app(), state, aws());
    expect(plan(app(), state).every((a) => a.op === "noop" || a.op === "dry")).toBe(true);
    const changed = app();
    changed.function[0]!.event = [{ ...rule, type: "order.refunded" }];
    const ops = plan(changed, state).filter((a) => a.type === "@aws.EventRule").map((a) => a.op);
    expect(ops.sort()).toEqual(["create", "delete"]);
  });

  test("removing a trigger deletes its rule, target and permission, before the bus", async () => {
    const state = emptyState();
    await applyAll(app(), state, aws());
    const calls = aws();
    await applyAll(baseConfig({ resource: [], function: [] }), state, calls);
    const names = calls.names();
    expect(names.indexOf("RemoveTargetsCommand")).toBeLessThan(names.indexOf("DeleteRuleCommand"));
    expect(names.indexOf("DeleteRuleCommand")).toBeLessThan(names.indexOf("DeleteEventBusCommand"));
    expect(calls.of("DeleteEventBusCommand")).toEqual([{ Name: "app-orders" }]);
    expect(calls.of("RemovePermissionCommand").length).toBeGreaterThan(0);
  });

  test("buses and rules carry the tags", async () => {
    const tags = { "cloudgear:managed-by": "cloudgear" };
    const withTags = fakeAws({ CreateEventBusCommand: () => ({ EventBusArn: "arn" }) }, undefined, undefined, tags);
    await applyAll(app(), emptyState(), withTags);
    expect(withTags.of("CreateEventBusCommand")[0].Tags).toEqual([{ Key: "cloudgear:managed-by", Value: "cloudgear" }, { Key: "cloudgear:resource", Value: "bus.orders" }]);
    expect(withTags.of("PutRuleCommand")[0].Tags.map((t: { Key: string }) => t.Key)).toContain("cloudgear:managed-by");
  });

  test("a rule on a bus that was renamed is replaced, not updated in place", async () => {
    const state = emptyState();
    await applyAll(app(), state, aws());
    const renamed = app({ resource: [{ name: "bus.orders", type: "@aws.EventBus", physical_name: "app-orders-v2", dry: false, source: "a.ts:1" }] });
    const ops = plan(renamed, state).filter((a) => a.type === "@aws.EventRule").map((a) => a.op);
    expect(ops.sort()).toEqual(["create", "delete"]);
  });

  test("a failure after the rule exists is resumable and the next apply does not duplicate it", async () => {
    const state = emptyState();
    let failed = false;
    const flaky = fakeAws({
      CreateEventBusCommand: () => ({ EventBusArn: "arn" }),
      PutTargetsCommand: () => {
        if (!failed) {
          failed = true;
          return { FailedEntryCount: 1, FailedEntries: [{ ErrorMessage: "denied" }] };
        }
        return { FailedEntryCount: 0 };
      },
    });
    await expect(applyAll(app(), state, flaky)).rejects.toThrow(/rejected the target/);
    const again = await applyAll(app(), state, flaky);
    expect(again.names().filter((n) => n === "CreateEventBusCommand")).toHaveLength(1);
    expect(plan(app(), state).every((a) => a.op === "noop" || a.op === "dry")).toBe(true);
  });

  test("an existing permission statement is accepted", async () => {
    const conflict = fakeAws({
      CreateEventBusCommand: () => ({ EventBusArn: "arn" }),
      AddPermissionCommand: (input: { Principal: string }) => {
        if (input.Principal === "events.amazonaws.com") throw Object.assign(new Error("The statement id (x) provided already exists."), { name: "ResourceConflictException" });
        return {};
      },
    });
    await applyAll(app(), emptyState(), conflict);
    expect(conflict.of("PutTargetsCommand")).toHaveLength(1);
  });
});
