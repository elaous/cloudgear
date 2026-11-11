import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Policy, assertPolicyDocument, assertPolicyName, broadStatements } from "@cloudgear/iam";
import { analyzeApp } from "../src/analyze/app";
import { apply } from "../src/deploy/apply";
import { decodeConfig, encodeConfig, type CloudgearConfig } from "../src/config/schema";
import { plan } from "../src/deploy/plan";
import { generate } from "../src/generate";
import { baseConfig, emptyState, fakeAws, fn } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "policies", `${name}.ts`);
const document = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::data/*" }] };

describe("Policy", () => {
  test("holds a name and a document", () => {
    const policy = new Policy("aws", { name: "read-bucket", document });
    expect(policy.name).toBe("read-bucket");
    expect(policy.document).toBe(document);
  });

  test.each([["", /Invalid policy name/], ["has space", /Invalid policy name/], ["x".repeat(129), /Invalid policy name/], ["cloudgear", /reserved/], ["CloudGear-x", /reserved/]])("the name %p is refused", (name, message) => {
    expect(() => assertPolicyName(name)).toThrow(message);
  });

  test("a document needs a version, a statement with an effect, an action and a resource", () => {
    expect(() => assertPolicyDocument({ Statement: [] })).toThrow(/needs Version/);
    expect(() => assertPolicyDocument({ Version: "2012-10-17", Statement: [] })).toThrow(/at least one Statement/);
    expect(() => assertPolicyDocument({ Version: "2012-10-17", Statement: [{ Action: "a", Resource: "*" }] })).toThrow(/Effect/);
    expect(() => assertPolicyDocument({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Resource: "*" }] })).toThrow(/needs an Action/);
    expect(() => assertPolicyDocument({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "a" }] })).toThrow(/needs a Resource/);
    expect(() => assertPolicyDocument({ Version: "2012-10-17", Statement: { Effect: "Deny", NotAction: "a", NotResource: "b" } })).not.toThrow();
    expect(() => assertPolicyDocument({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "a", Resource: "x".repeat(11_000) }] })).toThrow(/over IAM's 10240/);
    expect(() => new Policy("gcp" as never, { name: "x", document })).toThrow(/not supported yet/);
  });

  test("broad statements are those that allow every action or every resource", () => {
    expect(broadStatements({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:*", "*"], Resource: "*" }, { Effect: "Deny", Action: "*", Resource: "*" }] } as never)).toEqual([
      'statement 0 allows every action ("Action": "*")',
      'statement 0 applies to every resource ("Resource": "*")',
    ]);
  });
});

describe("analysis", () => {
  test("a JSON import and object literals are read, from routes and the router, once each", () => {
    const model = analyzeApp(fixture("basic"));
    const byName = Object.fromEntries(model.functions.map((f) => [f.name, f.policies.map((p) => p.name).sort()]));
    expect(byName).toEqual({ a: ["read-bucket", "send-queue", "shared-audit"], b: ["read-bucket", "shared-audit"] });
    const reader = model.functions[0]!.policies.find((p) => p.name === "read-bucket")!;
    expect(JSON.parse(reader.document)).toEqual({ Version: "2012-10-17", Statement: [{ Action: ["s3:GetObject"], Effect: "Allow", Resource: "arn:aws:s3:::data/*" }] });
    expect(Object.keys(JSON.parse(reader.document))).toEqual(["Statement", "Version"]);
  });

  test.each([
    ["reserved-name", /reserved/],
    ["no-statement", /at least one Statement/],
    ["not-literal", /can only hold literals, got: action/],
    ["duplicate-name", /a policy named "same" is also declared/],
    ["not-a-policy", /policies must be Policy variables declared in your project/],
    ["missing-json", /nope\.json could not be read as JSON/],
  ])("%s is rejected", (name, message) => {
    expect(() => analyzeApp(fixture(name))).toThrow(message);
  });

  test("a policy that allows everything is accepted with a warning", () => {
    const model = analyzeApp(fixture("broad"));
    expect(model.warnings.filter((w) => /policy "everything"/.test(w)).map((w) => w.replace(/^[^:]*:\d+: /, ""))).toEqual([
      'policy "everything": statement 0 allows every action ("Action": "*")',
      'policy "everything": statement 0 applies to every resource ("Resource": "*")',
    ]);
  });
});

describe("config and plan", () => {
  const generated = async (name: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policies-"));
    const { config } = await generate({ entry: fixture(name), configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "app" });
    return { config, text: fs.readFileSync(path.join(dir, "c.prototxt"), "utf8") };
  };

  test("the policies are written to the config and read back", async () => {
    const { config, text } = await generated("basic");
    expect(config.function.find((f) => f.name === "a")!.policy!.map((p) => p.name).sort()).toEqual(["read-bucket", "send-queue", "shared-audit"]);
    expect(decodeConfig(text).function.map((f) => f.policy)).toEqual(config.function.map((f) => f.policy));
  });

  const withPolicies = (policies?: { name: string; document: string }[]): CloudgearConfig => baseConfig({ resource: [], function: [fn({ permission: [], env: [], ...(policies ? { policy: policies } : {}) })] });
  const policy = (name: string, doc: unknown = document) => ({ name, document: JSON.stringify(doc) });

  test("a changed or added policy is a permissions update; an unchanged set is not", async () => {
    const state = emptyState();
    const aws = fakeAws();
    await apply(plan(withPolicies([policy("a"), policy("b")]), state), state, aws.drivers, { save: () => {} });
    expect(plan(withPolicies([policy("b"), policy("a")]), state).every((a) => a.op === "noop" || a.op === "dry")).toBe(true);
    const changed = plan(withPolicies([policy("a", { ...document, Id: "x" }), policy("b")]), state).find((a) => a.type === "@aws.Lambda")!;
    expect(changed).toMatchObject({ op: "update", changes: ["permissions"] });
  });
});

describe("deploying", () => {
  const policy = (name: string, doc: unknown = document) => ({ name, document: JSON.stringify(doc) });
  const config = (policies?: { name: string; document: string }[]) => baseConfig({ resource: [], function: [fn({ permission: [], env: [], ...(policies ? { policy: policies } : {}) })] });
  const put = (aws: ReturnType<typeof fakeAws>) => aws.of("PutRolePolicyCommand").map((p) => [p.PolicyName, JSON.parse(p.PolicyDocument)]);

  test("each declared policy is put on the role under its own name, next to none of cloudgear's when nothing is inferred", async () => {
    const aws = fakeAws();
    const state = emptyState();
    await apply(plan(config([policy("read-bucket"), policy("send-queue", { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: "*" }] })]), state), state, aws.drivers, { save: () => {} });
    expect(put(aws).map(([name]) => name)).toEqual(["read-bucket", "send-queue"]);
    expect(put(aws)[0]![1]).toEqual(document);
  });

  test("dropping a policy deletes it from the role, and the rest stay", async () => {
    const state = emptyState();
    await apply(plan(config([policy("a"), policy("b")]), state), state, fakeAws().drivers, { save: () => {} });
    const aws = fakeAws();
    await apply(plan(config([policy("b")]), state), state, aws.drivers, { save: () => {} });
    expect(aws.of("DeleteRolePolicyCommand").map((c) => c.PolicyName)).toContain("a");
    expect(aws.of("DeleteRolePolicyCommand").map((c) => c.PolicyName)).not.toContain("b");
    expect(put(aws).map(([name]) => name)).toContain("b");
  });

  test("destroy removes the declared policies, and from a role it leaves in place too", async () => {
    const own = emptyState();
    await apply(plan(config([policy("a")]), own), own, fakeAws().drivers, { save: () => {} });
    const gone = fakeAws();
    await apply(plan(baseConfig({ resource: [], function: [] }), own), own, gone.drivers, { save: () => {} });
    expect(gone.of("DeleteRolePolicyCommand").map((c) => c.PolicyName)).toContain("a");

    const imported = fakeAws({
      GetFunctionCommand: () => ({ Configuration: { FunctionArn: "arn:aws:lambda:eu-west-1:1:function:app-foo", Role: "arn:aws:iam::1:role/shared" } }),
      GetFunctionUrlConfigCommand: () => { throw Object.assign(new Error("x"), { name: "ResourceNotFoundException" }); },
    });
    const state = emptyState();
    const { adoptEntries } = await import("../src/deploy/adopt");
    await adoptEntries(plan(config([policy("a")]), state), state, imported.drivers, () => true);
    await apply(plan(config([policy("a")]), state), state, imported.drivers, { save: () => {} });
    expect(put(imported).map(([name]) => name)).toContain("a");
    const destroyed = fakeAws();
    await apply(plan(baseConfig({ resource: [], function: [] }), state), state, destroyed.drivers, { save: () => {} });
    expect(destroyed.of("DeleteRolePolicyCommand").map((c) => [c.RoleName, c.PolicyName])).toContainEqual(["shared", "a"]);
    expect(destroyed.of("DeleteRoleCommand")).toEqual([]);
  });

  test("a function that fails to be created leaves none of its policies behind", async () => {
    const aws = fakeAws({ CreateFunctionCommand: () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } });
    const state = emptyState();
    await expect(apply(plan(config([policy("a"), policy("b")]), state), state, aws.drivers, { save: () => {} })).rejects.toThrow(/denied/);
    const deleted = aws.of("DeleteRolePolicyCommand").map((c) => c.PolicyName);
    expect(deleted).toEqual(expect.arrayContaining(["a", "b"]));
  });
});
