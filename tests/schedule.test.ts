import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cron, toEventBridgeCron } from "@cloudgear/functions";
import { createHandler } from "@cloudgear/functions/drivers/aws";
import { analyzeApp } from "../src/analyze/app";
import { decodeConfig } from "../src/config/schema";
import { plan } from "../src/deploy/plan";
import { generate } from "../src/generate";
import { applyAll, baseConfig, emptyState, fakeAws, fn } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "schedule", name);
const generated = async (file: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-"));
  const configPath = path.join(dir, "c.prototxt");
  const { config } = await generate({ entry: file, configPath, buildDir: path.join(dir, "b"), project: "app" });
  return { config, dir, text: fs.readFileSync(configPath, "utf8") };
};

describe("cron", () => {
  test.each([
    ["*/15 * * * *", "cron(0/15 * * * ? *)"],
    ["0 9 * * 1-5", "cron(0 9 ? * 2-6 *)"],
    ["30 2 1 * *", "cron(30 2 1 * ? *)"],
    ["0 0 * * 0", "cron(0 0 ? * 1 *)"],
    ["0 0 * * 7", "cron(0 0 ? * 1 *)"],
    ["0 12 * * MON,WED,FRI", "cron(0 12 ? * 2,4,6 *)"],
    ["*/5 */4 * * *", "cron(0/5 0/4 * * ? *)"],
    ["0 0 15 jan-mar *", "cron(0 0 15 JAN-MAR ? *)"],
    ["0 0 * * 5-7", "cron(0 0 ? * 1,6,7 *)"],
    ["0 0 * * */2", "cron(0 0 ? * 1,3,5,7 *)"],
    ["0 0 * * *", "cron(0 0 * * ? *)"],
    ["  0   0 * * 0-6  ", "cron(0 0 * * ? *)"],
    ["0 0 * * 7/2", "cron(0 0 ? * 1 *)"],
    ["0 0 * * 5/2", "cron(0 0 ? * 1,6 *)"],
  ])("%s is %s on EventBridge", (expression, expected) => {
    expect(toEventBridgeCron(expression)).toBe(expected);
  });

  test.each([
    ["* */5 */4 * * *", /expected 5 fields.*got 6; seconds are not supported/],
    ["* * * *", /got 4/],
    ["60 * * * *", /minute "60": 60 is outside 0-59/],
    ["0 24 * * *", /hour/],
    ["0 0 0 * *", /day-of-month/],
    ["0 0 * 13 *", /month/],
    ["0 0 * * 8", /day-of-week/],
    ["a b c d e", /minute/],
    ["5-1 * * * *", /range/],
    ["*/0 * * * *", /step/],
    ["? * * * *", /minute "\?"/],
    ["0 0 ? * *", /day-of-month "\?"/],
    ["0 0 * * ?", /day-of-week "\?"/],
    ["*/100 * * * *", /minute step in "\*\/100": expected 1-59/],
    ["0 */25 * * *", /hour step/],
    ["0 0 30 2 *", /February never has day 30/],
    ["0 0 31 FEB *", /February never has day 31/],
    ["0 0 1 * 1", /cannot restrict both day-of-month and day-of-week/],
  ])("%s is rejected", (expression, error) => {
    expect(() => toEventBridgeCron(expression)).toThrow(error);
  });

  test("the cron tag is a fixed, normalized expression", () => {
    expect(cron`  0/15  * * * * `).toEqual({ expression: "0/15 * * * *" });
    expect(Object.isFrozen(cron`* * * * *`)).toBe(true);
    const minute = 5;
    expect(() => cron`${minute} * * * *`).toThrow(/without \${} substitutions/);
    expect(() => cron`* * *`).toThrow(/expected 5 fields/);
  });
});

describe("schedules in source", () => {
  test("a route option schedules a routed function; routes of one function add up without duplicates", () => {
    const model = analyzeApp(fixture("option.ts"));
    expect(Object.fromEntries(model.functions.map((f) => [f.name, f.schedules]))).toEqual({
      report: ["*/15 * * * *", "0 9 * * 1-5"],
      health: [],
    });
  });

  test("@schedule makes a static method a function of its own, with no route", () => {
    const model = analyzeApp(fixture("decorator.ts"));
    const jobs = Object.fromEntries(model.functions.map((f) => [f.name, f]));
    expect(jobs["Jobs-nightly"]).toMatchObject({ routes: [], schedules: ["0 3 * * *"], exportName: "Jobs", member: "nightly" });
    expect([...jobs["Jobs-nightly"]!.uses.values()]).toEqual([{ resource: "archive", path: "", accesses: new Set(["write"]) }]);
    expect(jobs["Jobs-twiceMonthly"]!.schedules.sort()).toEqual(["30 2 1 * *", "30 2 15 * *"]);
    expect(jobs.ping!.schedules).toEqual([]);
  });

  test("an app may have only scheduled functions", () => {
    const model = analyzeApp(fixture("only-scheduled.ts"));
    expect(model.functions.map((f) => [f.name, f.routes, f.schedules])).toEqual([["Jobs-tick", [], ["*/5 * * * *"]]]);
  });

  test("the decorator and the route option combine on one function", () => {
    const model = analyzeApp(fixture("decorator-on-route.ts"));
    expect(model.functions).toHaveLength(1);
    expect(model.functions[0]!.schedules.sort()).toEqual(["0 3 * * *", "0 4 * * *"]);
  });

  test.each([
    ["not-cron.ts", /a schedule must be cron`\.\.\.` from @cloudgear\/functions/],
    ["bad-cron.ts", /expected 5 fields/],
    ["both-days.ts", /cannot restrict both day-of-month and day-of-week/],
    ["substitution.ts", /cannot contain \${} substitutions/],
    ["options-variable.ts", /route options must be an object literal/],
    ["instance-method.ts", /@schedule applies to a static method of an exported class/],
  ])("rejects %s", (file, error) => {
    expect(() => analyzeApp(fixture(file))).toThrow(error);
  });
});

describe("schedules in the config", () => {
  test("round-trip through the prototxt", async () => {
    const { config, text } = await generated(fixture("option.ts"));
    expect(text).toContain('schedule: "*/15 * * * *"');
    expect(decodeConfig(text)).toEqual(config);
    expect(config.function.find((f) => f.name === "health")!.schedule).toBeUndefined();
  });

  test("a scheduled-only function has no route and its bundle runs on a scheduled event", async () => {
    const { config, dir } = await generated(fixture("only-scheduled.ts"));
    expect(config.function).toMatchObject([{ name: "Jobs-tick", route: [], schedule: ["*/5 * * * *"] }]);
    const script = `
      const { handler } = await import(${JSON.stringify(path.join(dir, "b/Jobs-tick/index.mjs"))});
      console.log(JSON.stringify(await handler({ source: "aws.events", time: "2026-10-26T10:00:00Z", resources: ["arn:rule"] })));
    `;
    const proc = Bun.spawnSync(["node", "--input-type=module", "-e", script], { cwd: dir, env: { ...process.env, AWS_LAMBDA_FUNCTION_NAME: "x" } });
    expect(proc.stderr.toString()).toBe("");
    expect(JSON.parse(proc.stdout.toString())).toMatchObject({ statusCode: 200, body: JSON.stringify({ ticked: true }) });
  });
});

describe("the scheduled event in the Lambda adapter", () => {
  const event = { source: "aws.events" as const, time: "2026-10-26T10:00:00Z", resources: ["arn:aws:events:x:1:rule/r"] };

  test("calls the function with the schedule time and rule, and an empty context", async () => {
    const seen: unknown[] = [];
    const handler = createHandler(async (input: unknown, context: unknown) => (seen.push(input, context), { ok: true }), []);
    expect((await handler(event)).statusCode).toBe(200);
    expect(seen).toEqual([{ scheduledTime: event.time, rule: event.resources[0] }, {}]);
  });

  test("a failing run is thrown so Lambda records the failure", async () => {
    const log = console.error;
    console.error = () => {};
    try {
      const handler = createHandler(async () => {
        throw new Error("boom");
      }, []);
      await expect(handler(event)).rejects.toThrow(/Scheduled run failed with status 500/);
    } finally {
      console.error = log;
    }
  });

  test("token verification does not apply, but a forged-looking HTTP request still needs it", async () => {
    const authenticate = async () => null;
    const handler = createHandler(async () => ({ ok: true }), [{ method: "GET", path: "/x" }], { authenticate });
    expect((await handler(event)).statusCode).toBe(200);
    const http = await handler({ rawPath: "/x", headers: {}, requestContext: { http: { method: "GET" } }, source: "aws.events" } as never);
    expect(http.statusCode).toBe(401);
  });
});

describe("planning and deploying schedules", () => {
  const scheduled = (schedule: string[] = ["*/15 * * * *"], overrides = {}) =>
    baseConfig({ resource: [], function: [fn({ permission: [], env: [], schedule, ...overrides })] });

  test("a schedule is created after its function and deleted before it", async () => {
    const created = plan(scheduled(), emptyState());
    expect(created.map((a) => [a.type, a.op])).toEqual([["@aws.Lambda", "create"], ["@aws.Schedule", "create"]]);

    const state = emptyState();
    const aws = fakeAws();
    await applyAll(scheduled(), state, aws);
    const ruleName = Object.values(state.entries).find((e) => e.type === "@aws.Schedule")!.physical_name;
    expect(ruleName).toMatch(/^app-foo-[0-9a-f]{8}$/);
    const order = aws.names().filter((n) => ["CreateFunctionCommand", "PutRuleCommand", "PutTargetsCommand"].includes(n));
    expect(order).toEqual(["CreateFunctionCommand", "PutRuleCommand", "PutTargetsCommand"]);
    expect(aws.of("PutRuleCommand")).toEqual([
      { Name: ruleName, ScheduleExpression: "cron(0/15 * * * ? *)", State: "ENABLED", Description: "cloudgear: */15 * * * * UTC" },
    ]);
    const permission = aws.of("AddPermissionCommand").find((p) => p.Principal === "events.amazonaws.com");
    expect(permission).toMatchObject({
      FunctionName: "app-foo",
      Action: "lambda:InvokeFunction",
      SourceArn: `arn:aws:events:eu-west-1:1:rule/${ruleName}`,
    });
    expect(aws.of("PutTargetsCommand")).toEqual([{ Rule: ruleName, Targets: [{ Id: "cloudgear", Arn: "arn:aws:lambda:x:1:function:app-foo" }] }]);

    expect(plan(scheduled(), state).every((a) => a.op === "noop")).toBe(true);

    const removal = plan(scheduled([]), state);
    expect(removal.map((a) => [a.type, a.op])).toEqual([["@aws.Lambda", "noop"], ["@aws.Schedule", "delete"]]);
    await applyAll(scheduled([]), state, aws);
    expect(aws.of("RemoveTargetsCommand")).toEqual([{ Rule: ruleName, Ids: ["cloudgear"] }]);
    expect(aws.of("DeleteRuleCommand")).toEqual([{ Name: ruleName }]);
    expect(aws.names()).toContain("RemovePermissionCommand");
  });

  test("changing the expression or the function name replaces the rule", async () => {
    const state = emptyState();
    const aws = fakeAws();
    await applyAll(scheduled(["*/15 * * * *"]), state, aws);
    const changed = plan(scheduled(["0 9 * * 1-5"]), state);
    expect(changed.filter((a) => a.key.startsWith("@aws.Schedule")).map((a) => a.op).sort()).toEqual(["create", "delete"]);

    const renamed = plan(scheduled(["*/15 * * * *"], { physical_name: "app-bar", name: "bar" }), state);
    expect(renamed.filter((a) => a.key.startsWith("@aws.Schedule")).map((a) => a.op).sort()).toEqual(["create", "delete"]);

    const replaced = plan(scheduled(["*/15 * * * *"], { physical_name: "app-foo2" }), state);
    expect(replaced.find((a) => a.key.startsWith("@aws.Lambda"))!.op).toBe("replace");
    expect(replaced.filter((a) => a.key.startsWith("@aws.Schedule")).map((a) => a.op).sort()).toEqual(["create", "delete"]);
  });

  test("a rule target EventBridge rejects fails the apply and keeps the rule for the next one", async () => {
    const state = emptyState();
    const failing = fakeAws({ PutTargetsCommand: () => ({ FailedEntryCount: 1, FailedEntries: [{ ErrorMessage: "no access" }] }) });
    await expect(applyAll(scheduled(), state, failing)).rejects.toThrow(/rejected the target.*no access/);
    const entry = Object.values(state.entries).find((e) => e.type === "@aws.Schedule")!;
    expect(entry.outputs.rule_arn).toBeDefined();
    await applyAll(scheduled(), state, fakeAws());
    expect(plan(scheduled(), state).every((a) => a.op === "noop")).toBe(true);
  });

  test("a function with only a schedule gets no URL until it gets a route", async () => {
    const state = emptyState();
    const aws = fakeAws();
    await applyAll(scheduled(["0 3 * * *"], { route: [] }), state, aws);
    expect(aws.names()).not.toContain("CreateFunctionUrlConfigCommand");
    expect(state.entries["@aws.Lambda.foo"]!.outputs.url).toBeUndefined();

    const routed = scheduled(["0 3 * * *"]);
    expect(plan(routed, state).find((a) => a.key === "@aws.Lambda.foo")).toMatchObject({ op: "update", changes: ["auth"] });
    await applyAll(routed, state, aws);
    expect(aws.of("CreateFunctionUrlConfigCommand")).toHaveLength(1);
    expect(state.entries["@aws.Lambda.foo"]!.outputs.url).toMatch(/^https:/);
    expect(plan(routed, state).every((a) => a.op === "noop")).toBe(true);
  });

  test("two long function names that differ late and share a cron get different rules", () => {
    const long = (suffix: string) => fn({ name: `long${suffix}`, physical_name: `${"x".repeat(60)}${suffix}`, permission: [], env: [], schedule: ["0 3 * * *"] });
    const rules = plan(baseConfig({ resource: [], function: [long("a"), long("b")] }), emptyState()).filter((a) => a.type === "@aws.Schedule");
    expect(new Set(rules.map((a) => a.desired!.physical_name)).size).toBe(2);
    expect(rules.every((a) => a.desired!.physical_name.length <= 64)).toBe(true);
  });

  test("a routed function that becomes schedule-only loses its URL and permissions", async () => {
    const state = emptyState();
    const aws = fakeAws();
    await applyAll(scheduled(["0 3 * * *"]), state, aws);
    expect(state.entries["@aws.Lambda.foo"]!.outputs.url).toMatch(/^https:/);
    await applyAll(scheduled(["0 3 * * *"], { route: [] }), state, aws);
    expect(aws.of("DeleteFunctionUrlConfigCommand")).toEqual([{ FunctionName: "app-foo" }]);
    expect(state.entries["@aws.Lambda.foo"]!.outputs.url).toBe("");
    expect(plan(scheduled(["0 3 * * *"], { route: [] }), state).every((a) => a.op === "noop")).toBe(true);
  });

  test("a hand-edited invalid cron is rejected by plan", () => {
    expect(() => plan(scheduled(["* * * * * *"]), emptyState())).toThrow(/expected 5 fields/);
  });
});
