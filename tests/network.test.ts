import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Network } from "@cloudgear/network";
import { analyzeApp } from "../src/analyze/app";
import { adoptEntries } from "../src/deploy/adopt";
import { apply } from "../src/deploy/apply";
import { plan } from "../src/deploy/plan";
import { stateKey } from "../src/deploy/state";
import { validateOptions } from "../src/providers";
import { generate } from "../src/generate";
import { applyAll, baseConfig, emptyState, fakeAws, fn } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "network", `${name}.ts`);
const VPC_POLICY = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole";
const configWith = (options?: Record<string, string>) => baseConfig({ function: [fn(options ? { options } : {})] });
const KEY = stateKey({ type: "@aws.Lambda", name: "foo" });

describe("Network", () => {
  test("validates ids and requires a vpc for subnets and security groups", () => {
    expect(new Network("aws").options).toEqual({});
    expect(new Network("aws", { vpc: "vpc-0abc1234", subnets: ["subnet-aaaa1111"], securityGroups: ["sg-0def4001"] }).options.vpc).toBe("vpc-0abc1234");
    expect(() => new Network("gcp" as "aws")).toThrow(/not supported yet/);
    expect(() => new Network("aws", { vpc: "vpc-xyz" })).toThrow(/Invalid VPC id/);
    expect(() => new Network("aws", { subnets: ["subnet-aaaa1111"] })).toThrow(/need a vpc/);
    expect(() => new Network("aws", { vpc: "vpc-0abc1234", subnets: ["nope"] })).toThrow(/Invalid subnet id/);
    expect(() => new Network("aws", { vpc: "vpc-0abc1234", subnets: [] })).toThrow(/must not be empty/);
    expect(() => new Network("aws", { vpc: "vpc-0abc1234", securityGroups: ["sg-0def4001", "sg-0def4001"] })).toThrow(/twice/);
    expect(() => new Network("aws", { vpc: "vpc-0abc1234", securityGroups: Array.from({ length: 6 }, (_, i) => `sg-0def400${i}`) })).toThrow(/at most 5/);
  });
});

describe("analysis", () => {
  test("a network reaches every function as options, and a router without one adds nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "network-"));
    const run = async (name: string) => (await generate({ entry: fixture(name), configPath: path.join(dir, `${name}.prototxt`), buildDir: path.join(dir, "b"), project: "app" })).config.function;
    expect((await run("default")).map((f) => f.options)).toEqual([{ vpc: "default" }, { vpc: "default" }]);
    expect((await run("explicit")).map((f) => f.options)).toEqual([{ vpc: "vpc-0abc1234", subnets: "subnet-aaaa1111,subnet-bbbb2222", security_groups: "sg-0def4001" }]);
    expect((await run("none")).map((f) => f.options)).toEqual([undefined]);
  });

  test("an inline Network, a cast, and an id from the environment all resolve", () => {
    const options = (name: string, env?: Record<string, string>) => analyzeApp(fixture(name), env).functions[0]!.options;
    expect(options("inline")).toEqual({ vpc: "vpc-0abc1234" });
    expect(options("as-cast")).toEqual({ vpc: "default" });
    expect(options("env", { VPC_ID: "vpc-0abc5678" })).toEqual({ vpc: "vpc-0abc5678" });
    expect(() => options("env", {})).toThrow(/environment variable VPC_ID is unset or empty/);
  });

  test("a reassignable variable and a route that overrides the network are errors", () => {
    expect(() => analyzeApp(fixture("let"))).toThrow(/network must be a Network declared in your project/);
    expect(() => analyzeApp(fixture("route-override"))).toThrow(/route options of "ping" set vpc, which the router's network already sets/);
  });

  test("a clash, a non-Network value, a bad id and an unknown option are errors", () => {
    expect(() => analyzeApp(fixture("conflict"))).toThrow(/give the network option or functionOptions\.vpc, not both/);
    expect(() => analyzeApp(fixture("not-a-network"))).toThrow(/network must be a Network declared in your project/);
    expect(() => analyzeApp(fixture("bad-vpc"))).toThrow(/Invalid VPC id "vpc-xyz"/);
    expect(() => analyzeApp(fixture("typo"))).toThrow(/unknown option "vpcs" \(supported: vpc, subnets, securityGroups\)/);
  });
});

describe("lambda driver", () => {
  test("a function in the default VPC gets one subnet per zone, the default security group and the VPC policy", async () => {
    const aws = fakeAws();
    const state = emptyState();
    await applyAll(configWith({ vpc: "default" }), state, aws);
    expect(aws.of("DescribeVpcsCommand")[0]).toEqual({ Filters: [{ Name: "is-default", Values: ["true"] }] });
    expect(aws.of("CreateFunctionCommand")[0]).toMatchObject({ VpcConfig: { SubnetIds: ["subnet-aaaa1111", "subnet-bbbb2222"], SecurityGroupIds: ["sg-0def4001"] } });
    expect(aws.of("AttachRolePolicyCommand").map((c) => c.PolicyArn)).toContain(VPC_POLICY);
    expect(state.entries[KEY]!.outputs).toMatchObject({ vpc_id: "vpc-0def0001", subnet_ids: "subnet-aaaa1111,subnet-bbbb2222", security_group_ids: "sg-0def4001" });
  });

  test("named subnets and security groups are used as given, after checking they belong to the VPC", async () => {
    const aws = fakeAws();
    await applyAll(configWith({ vpc: "vpc-0abc1234", subnets: "subnet-cccc3333", security_groups: "sg-0def4001" }), emptyState(), aws);
    expect(aws.of("CreateFunctionCommand")[0]).toMatchObject({ VpcConfig: { SubnetIds: ["subnet-cccc3333"], SecurityGroupIds: ["sg-0def4001"] } });
    expect(aws.of("DescribeSubnetsCommand")[0]).toMatchObject({ Filters: [{ Name: "vpc-id", Values: ["vpc-0abc1234"] }], SubnetIds: ["subnet-cccc3333"] });
  });

  test("a bad network fails before anything is created", async () => {
    const missingSubnet = fakeAws();
    await expect(applyAll(configWith({ vpc: "vpc-0abc1234", subnets: "subnet-dddd4444" }), emptyState(), missingSubnet)).rejects.toThrow(/Subnets subnet-dddd4444 are not in VPC vpc-0abc1234/);
    expect(missingSubnet.names()).not.toContain("CreateRoleCommand");

    const missingGroup = fakeAws();
    await expect(applyAll(configWith({ vpc: "vpc-0abc1234", security_groups: "sg-0000dead" }), emptyState(), missingGroup)).rejects.toThrow(/Security groups sg-0000dead are not in VPC/);
    expect(missingGroup.names()).not.toContain("CreateFunctionCommand");

    const noDefault = fakeAws({ DescribeVpcsCommand: () => ({ Vpcs: [] }) });
    await expect(applyAll(configWith({ vpc: "default" }), emptyState(), noDefault)).rejects.toThrow(/There is no default VPC in eu-west-1; declare new Network/);
    expect(noDefault.names()).not.toContain("CreateRoleCommand");
  });

  test("a role that Lambda cannot use yet is retried", async () => {
    const aws = fakeAws({
      CreateFunctionCommand: (input, attempt) => {
        if (attempt < 2) throw new Error("The provided execution role does not have permissions to call CreateNetworkInterface on EC2");
        return { FunctionArn: `arn:aws:lambda:x:1:function:${input.FunctionName}` };
      },
    });
    await applyAll(configWith({ vpc: "default" }), emptyState(), aws);
    expect(aws.of("CreateFunctionCommand")).toHaveLength(3);
  });

  test("adding a network updates the configuration, and removing it empties the VpcConfig and detaches the policy", async () => {
    const aws = fakeAws();
    const state = emptyState();
    await applyAll(configWith(), state, aws);
    expect(aws.of("CreateFunctionCommand")[0]).not.toHaveProperty("VpcConfig");

    const before = aws.calls.length;
    await apply(plan(configWith({ vpc: "default" }), state), state, aws.drivers, { save: () => {} });
    const added = aws.calls.slice(before);
    expect(added.find((c) => c.name === "UpdateFunctionConfigurationCommand")!.input).toMatchObject({ VpcConfig: { SubnetIds: ["subnet-aaaa1111", "subnet-bbbb2222"], SecurityGroupIds: ["sg-0def4001"] } });
    expect(added.filter((c) => c.name === "AttachRolePolicyCommand").map((c) => c.input.PolicyArn)).toEqual([VPC_POLICY]);
    expect(state.entries[KEY]!.outputs.vpc_id).toBe("vpc-0def0001");

    const mark = aws.calls.length;
    await apply(plan(configWith(), state), state, aws.drivers, { save: () => {} });
    const removed = aws.calls.slice(mark);
    expect(removed.find((c) => c.name === "UpdateFunctionConfigurationCommand")!.input).toMatchObject({ VpcConfig: { SubnetIds: [], SecurityGroupIds: [] } });
    expect(removed.filter((c) => c.name === "DetachRolePolicyCommand").map((c) => c.input.PolicyArn)).toEqual([VPC_POLICY]);
    expect(state.entries[KEY]!.outputs).toMatchObject({ vpc_id: "", subnet_ids: "", security_group_ids: "" });
  });

  test("a function that never had a network is not touched by a config change", async () => {
    const aws = fakeAws();
    const state = emptyState();
    await applyAll(configWith(), state, aws);
    const before = aws.calls.length;
    await apply(plan(baseConfig({ function: [fn({ memory_mb: 512 })] }), state), state, aws.drivers, { save: () => {} });
    const update = aws.calls.slice(before).find((c) => c.name === "UpdateFunctionConfigurationCommand")!;
    expect(update.input).not.toHaveProperty("VpcConfig");
    expect(aws.calls.slice(before).some((c) => c.name === "DescribeVpcsCommand")).toBe(false);
  });

  test("deleting a function detaches the VPC policy before removing its role", async () => {
    const aws = fakeAws();
    const state = emptyState();
    await applyAll(configWith({ vpc: "default" }), state, aws);
    const before = aws.calls.length;
    await apply(plan(baseConfig({ function: [] }), state), state, aws.drivers, { save: () => {} });
    const names = aws.calls.slice(before).map((c) => `${c.name}:${c.input.PolicyArn ?? ""}`);
    expect(names.indexOf(`DetachRolePolicyCommand:${VPC_POLICY}`)).toBeGreaterThan(-1);
    expect(names.indexOf(`DetachRolePolicyCommand:${VPC_POLICY}`)).toBeLessThan(names.indexOf("DeleteRoleCommand:"));
  });

  test("changing only the network is planned as a configuration update", () => {
    const state = emptyState();
    state.entries[KEY] = { kind: "function", type: "@aws.Lambda", name: "foo", physical_name: "app-foo", spec: plan(configWith(), emptyState()).find((a) => a.type === "@aws.Lambda")!.desired!.spec, outputs: {}, deps: [] } as never;
    const next = plan(configWith({ vpc: "default" }), state).find((a) => a.type === "@aws.Lambda")!;
    expect(next.op).toBe("update");
    expect(next.changes).toContain("config");
  });
});

const FUNCTION_ARN = "arn:aws:lambda:eu-west-1:1:function:app-foo";
const inVpc = (role: string) => ({
  GetFunctionCommand: () => ({ Configuration: { FunctionArn: FUNCTION_ARN, Role: `arn:aws:iam::1:role/${role}`, VpcConfig: { VpcId: "vpc-0abc1234", SubnetIds: ["subnet-aaaa1111"], SecurityGroupIds: ["sg-0def4001"] } } }),
});
const isFunction = (a: { type: string }) => a.type === "@aws.Lambda";
const policyCalls = (calls: { name: string; input: any }[], name: string) => calls.filter((c) => c.name === name && c.input.PolicyArn === VPC_POLICY);

describe("imported functions", () => {
  test("import records the VPC a function runs in, and apply without a network takes it out", async () => {
    const aws = fakeAws(inVpc("shared-role"));
    const state = emptyState();
    const adopted = await adoptEntries(plan(configWith(), state), state, aws.drivers, isFunction);
    expect(adopted.notes.join(" ")).toMatch(/runs in VPC vpc-0abc1234, and will be taken out of it/);
    expect(state.entries[KEY]!.outputs).toMatchObject({ vpc_id: "vpc-0abc1234", subnet_ids: "subnet-aaaa1111", security_group_ids: "sg-0def4001" });

    const before = aws.calls.length;
    await apply(plan(configWith(), state), state, aws.drivers, { save: () => {} });
    const after = aws.calls.slice(before);
    expect(after.find((c) => c.name === "UpdateFunctionConfigurationCommand")!.input).toMatchObject({ VpcConfig: { SubnetIds: [], SecurityGroupIds: [] } });
    expect(policyCalls(after, "DetachRolePolicyCommand")).toEqual([]);
    expect(state.entries[KEY]!.outputs.vpc_id).toBe("");
  });

  test("moving an imported function to another VPC gives its role the policy and keeps it", async () => {
    const aws = fakeAws(inVpc("shared-role"));
    const state = emptyState();
    await adoptEntries(plan(configWith(), state), state, aws.drivers, isFunction);
    const before = aws.calls.length;
    await apply(plan(configWith({ vpc: "vpc-0abc5678" }), state), state, aws.drivers, { save: () => {} });
    const after = aws.calls.slice(before);
    expect(after.find((c) => c.name === "UpdateFunctionConfigurationCommand")!.input).toMatchObject({ VpcConfig: { SecurityGroupIds: ["sg-0def4001"] } });
    expect(policyCalls(after, "AttachRolePolicyCommand")).toHaveLength(0);
    await apply(plan(configWith(), state), state, aws.drivers, { save: () => {} });
    expect(policyCalls(aws.calls, "DetachRolePolicyCommand")).toEqual([]);
  });
});

describe("failures and edge cases", () => {
  test("a failed update leaves no VPC policy on a role cloudgear created, and none is touched on an imported one", async () => {
    const own = fakeAws({ UpdateFunctionConfigurationCommand: () => { throw new Error("no free IP addresses in the subnet"); } });
    const state = emptyState();
    const ok = fakeAws();
    await applyAll(configWith(), state, ok);
    const before = own.calls.length;
    await expect(apply(plan(configWith({ vpc: "default" }), state), state, own.drivers, { save: () => {} })).rejects.toThrow(/no free IP addresses/);
    const after = own.calls.slice(before);
    expect(policyCalls(after, "AttachRolePolicyCommand")).toHaveLength(1);
    expect(policyCalls(after, "DetachRolePolicyCommand")).toHaveLength(1);
    expect(state.entries[KEY]!.spec.options).toBeUndefined();
  });

  test("a role that lacks any network permission yet is retried", async () => {
    const aws = fakeAws({
      UpdateFunctionConfigurationCommand: (_input, attempt) => {
        if (attempt < 2) throw new Error("The provided execution role does not have permissions to call DescribeNetworkInterfaces on EC2");
        return {};
      },
    });
    const state = emptyState();
    await applyAll(configWith(), state, fakeAws());
    await apply(plan(configWith({ vpc: "default" }), state), state, aws.drivers, { save: () => {} });
    expect(aws.of("UpdateFunctionConfigurationCommand")).toHaveLength(3);
  });

  test("changing from one VPC to another is a configuration update with the new network", async () => {
    const aws = fakeAws();
    const state = emptyState();
    await applyAll(configWith({ vpc: "vpc-0abc1234" }), state, aws);
    const before = aws.calls.length;
    await apply(plan(configWith({ vpc: "vpc-0abc5678" }), state), state, aws.drivers, { save: () => {} });
    const after = aws.calls.slice(before);
    expect(after.find((c) => c.name === "DescribeVpcsCommand")!.input).toEqual({ VpcIds: ["vpc-0abc5678"] });
    expect(state.entries[KEY]!.outputs.vpc_id).toBe("vpc-0abc5678");
    expect(policyCalls(after, "AttachRolePolicyCommand")).toHaveLength(0);
  });

  test("a plain function's delete makes no VPC policy call", async () => {
    const aws = fakeAws();
    const state = emptyState();
    await applyAll(configWith(), state, aws);
    const before = aws.calls.length;
    await apply(plan(baseConfig({ function: [] }), state), state, aws.drivers, { save: () => {} });
    expect(policyCalls(aws.calls.slice(before), "DetachRolePolicyCommand")).toEqual([]);
  });

  test("default subnets skip unusable ones and prefer the most free addresses in each zone", async () => {
    const aws = fakeAws({
      DescribeSubnetsCommand: () => ({
        Subnets: [
          { SubnetId: "subnet-aaaa0001", AvailabilityZone: "eu-west-1a", State: "available", AvailableIpAddressCount: 5 },
          { SubnetId: "subnet-aaaa0002", AvailabilityZone: "eu-west-1a", State: "available", AvailableIpAddressCount: 200 },
          { SubnetId: "subnet-bbbb0001", AvailabilityZone: "eu-west-1b", State: "pending", AvailableIpAddressCount: 300 },
          { SubnetId: "subnet-bbbb0002", AvailabilityZone: "eu-west-1b", State: "available", Ipv6Native: true, AvailableIpAddressCount: 300 },
          { SubnetId: "subnet-cccc0001", AvailabilityZone: "eu-west-1c", State: "available", AvailableIpAddressCount: 50 },
          { SubnetId: "subnet-dddd0001", AvailabilityZone: "eu-west-1-lax-1a", State: "available", AvailableIpAddressCount: 900 },
        ],
      }),
    });
    await applyAll(configWith({ vpc: "default" }), emptyState(), aws);
    expect(aws.of("CreateFunctionCommand")[0].VpcConfig.SubnetIds).toEqual(["subnet-aaaa0002", "subnet-cccc0001"]);
    expect(aws.logs.some((m) => /functions will use subnets subnet-aaaa0002, subnet-cccc0001/.test(m))).toBe(true);

    const none = fakeAws({ DescribeSubnetsCommand: () => ({ Subnets: [{ SubnetId: "subnet-aaaa0001", AvailabilityZone: "eu-west-1a", State: "pending" }] }) });
    await expect(applyAll(configWith({ vpc: "default" }), emptyState(), none)).rejects.toThrow(/no subnet Lambda can use/);
  });

  test("EC2 not-found errors become plain messages and nothing is created", async () => {
    const named = (name: string) => () => {
      throw Object.assign(new Error(name), { name });
    };
    const vpc = fakeAws({ DescribeVpcsCommand: named("InvalidVpcID.NotFound") });
    await expect(applyAll(configWith({ vpc: "vpc-0abc1234" }), emptyState(), vpc)).rejects.toThrow(/VPC vpc-0abc1234 was not found in eu-west-1/);
    const subnet = fakeAws({ DescribeSubnetsCommand: named("InvalidSubnetID.NotFound") });
    await expect(applyAll(configWith({ vpc: "vpc-0abc1234", subnets: "subnet-aaaa1111" }), emptyState(), subnet)).rejects.toThrow(/Subnets subnet-aaaa1111 were not found in VPC vpc-0abc1234/);
    const group = fakeAws({ DescribeSecurityGroupsCommand: named("InvalidGroup.NotFound") });
    await expect(applyAll(configWith({ vpc: "vpc-0abc1234", security_groups: "sg-0def4001" }), emptyState(), group)).rejects.toThrow(/Security groups sg-0def4001 were not found/);
    for (const aws of [vpc, subnet, group]) expect(aws.names()).not.toContain("CreateRoleCommand");
  });
});

describe("option validation", () => {
  test("network options are checked, and subnets need a vpc", () => {
    validateOptions("aws", "@aws.Lambda", { vpc: "default", subnets: "subnet-aaaa1111,subnet-bbbb2222", security_groups: "sg-0def4001" }, "f");
    expect(() => validateOptions("aws", "@aws.Lambda", { vpc: "vpc-xyz" }, "f")).toThrow(/must be "default" or a VPC id/);
    expect(() => validateOptions("aws", "@aws.Lambda", { subnets: "nope" }, "f")).toThrow(/comma-separated list of distinct subnet ids/);
    expect(() => validateOptions("aws", "@aws.Lambda", { subnets: Array.from({ length: 17 }, (_, i) => `subnet-aaaa${String(i).padStart(4, "0")}`).join(",") }, "f")).toThrow(/at most 16 subnet ids/);
    expect(() => plan(configWith({ subnets: "subnet-aaaa1111" }), emptyState())).toThrow(/subnets and security_groups need a vpc/);
  });
});
