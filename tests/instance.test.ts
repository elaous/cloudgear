import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Instance } from "@cloudgear/instance";
import { analyzeApp } from "../src/analyze/app";
import { adoptEntries } from "../src/deploy/adopt";
import { apply, type Drivers } from "../src/deploy/apply";
import { awsDrivers, type SendClient } from "../src/deploy/aws";
import { plan } from "../src/deploy/plan";
import { stateKey } from "../src/deploy/state";
import { validateOptions } from "../src/providers";
import type { CloudgearConfig } from "../src/config/schema";
import { generate } from "../src/generate";
import { baseConfig, emptyState, fakeAws } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", "instance", `${name}.ts`);
const KEY = stateKey({ type: "@aws.EC2", name: "instance.worker" });

const resource = (options: Record<string, string> = {}) => ({ name: "instance.worker", type: "@aws.EC2", physical_name: "app-worker", dry: false, source: "setup.ts:1", options: { vpc: "default", ...options } });
const configWith = (options?: Record<string, string>): CloudgearConfig => baseConfig({ resource: [resource(options)], function: [] });
const empty = () => baseConfig({ resource: [], function: [] });

interface Vm {
  id: string;
  name: string;
  state: string;
  busy: number;
  type: string;
  image: string;
}

function fakeFleet(initial: Vm[] = [], opts: { stuck?: boolean; dies?: boolean } = {}) {
  const vms = new Map<string, Vm>(initial.map((vm) => [vm.id, vm]));
  const base = fakeAws();
  const calls: { name: string; input: any }[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let ssmCalls = 0;
  const err = (name: string) => Object.assign(new Error(name), { name });
  const view = (vm: Vm, state = vm.state) => ({
    InstanceId: vm.id,
    State: { Name: state },
    InstanceType: vm.type,
    ImageId: vm.image,
    Placement: { AvailabilityZone: "eu-west-1a" },
    PrivateIpAddress: "10.0.0.5",
    PublicIpAddress: state === "running" ? "203.0.113.7" : undefined,
    PublicDnsName: state === "running" ? "ec2-203-0-113-7.compute.amazonaws.com" : "",
  });
  const settle = (vm: Vm): string => {
    if (opts.stuck && vm.state === "pending") return "pending";
    if (vm.busy > 0) {
      vm.busy--;
      if (vm.busy === 0) {
        if (vm.state === "pending") vm.state = opts.dies ? "terminated" : "running";
        else if (vm.state === "shutting-down") vm.state = "terminated";
      }
    }
    return vm.state;
  };
  const ec2: SendClient = {
    async send(command) {
      const name = command.constructor.name as string;
      const input = command.input;
      if (!["DescribeInstancesCommand", "RunInstancesCommand", "TerminateInstancesCommand", "DescribeImagesCommand"].includes(name)) return base.client.send(command);
      calls.push({ name, input });
      switch (name) {
        case "DescribeInstancesCommand": {
          let found: Vm[];
          if (input.InstanceIds) {
            found = input.InstanceIds.map((id: string) => vms.get(id)).filter(Boolean) as Vm[];
            if (!found.length) throw err("InvalidInstanceID.NotFound");
          } else {
            const wanted = input.Filters.find((f: { Name: string }) => f.Name === "tag:Name").Values[0];
            const states = input.Filters.find((f: { Name: string }) => f.Name === "instance-state-name").Values;
            found = [...vms.values()].filter((vm) => vm.name === wanted && states.includes(vm.state));
          }
          return { Reservations: found.map((vm) => ({ Instances: [view(vm, settle(vm))] })) };
        }
        case "RunInstancesCommand": {
          const vm: Vm = { id: `i-0${vms.size + 1}`.padEnd(10, "0"), name: input.TagSpecifications[0].Tags.find((t: { Key: string }) => t.Key === "Name").Value, state: "pending", busy: 2, type: input.InstanceType, image: input.ImageId };
          vms.set(vm.id, vm);
          return { Instances: [{ InstanceId: vm.id }] };
        }
        case "TerminateInstancesCommand": {
          const vm = vms.get(input.InstanceIds[0]);
          if (!vm) throw err("InvalidInstanceID.NotFound");
          vm.state = "shutting-down";
          vm.busy = 2;
          return {};
        }
        case "DescribeImagesCommand":
          return { Images: [{ RootDeviceName: "/dev/xvda" }] };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const ssm: SendClient = {
    async send(command) {
      ssmCalls++;
      calls.push({ name: command.constructor.name, input: command.input });
      return { Parameter: { Value: "ami-0latest01" } };
    },
  };
  const drivers = awsDrivers({
    region: "eu-west-1",
    tags: { "cloudgear:project": "app" },
    readBundle: () => new Uint8Array(),
    clients: { ec2, ssm },
    sleep: async (ms) => void sleeps.push(ms),
    log: (m) => void logs.push(m),
  });
  return { vms, calls, sleeps, logs, drivers, ssmCalls: () => ssmCalls, names: () => calls.map((c) => c.name) };
}

async function applyConfig(config: CloudgearConfig, state: ReturnType<typeof emptyState>, drivers: Drivers) {
  await apply(plan(config, state), state, drivers, { save: () => {}, log: () => {} });
}

describe("Instance", () => {
  test("validates the provider, name and every option without side effects", () => {
    expect(new Instance("aws", "worker", { size: "small", image: "ami-0abc1234", diskGb: 20 }).name).toBe("worker");
    expect(() => new Instance("gcp" as "aws", "w")).toThrow(/not supported yet/);
    expect(() => new Instance("aws", "")).toThrow(/Invalid instance name/);
    expect(() => new Instance("aws", "w", { size: "huge" as "small" })).toThrow(/Unsupported instance size/);
    expect(() => new Instance("aws", "w", { image: "ubuntu" })).toThrow(/Invalid image/);
    expect(() => new Instance("aws", "w", { diskGb: 0 })).toThrow(/diskGb must be/);
    expect(() => new Instance("aws", "w", { keyName: "" })).toThrow(/Invalid keyName/);
    expect(() => new Instance("aws", "w", { profile: "bad profile" })).toThrow(/Invalid profile/);
    expect(() => new Instance("aws", "w", { userData: "x".repeat(16385) })).toThrow(/userData is over/);
  });
});

describe("analysis", () => {
  test("instances become @aws.EC2 resources carrying what was set and a network", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instance-"));
    const { config } = await generate({ entry: fixture("basic"), configPath: path.join(dir, "c.prototxt"), buildDir: path.join(dir, "b"), project: "app" });
    expect(config.resource.map((r) => [r.name, r.type, r.physical_name, r.options])).toEqual([
      ["instance.worker", "@aws.EC2", "app-worker", { size: "small", image: "ami-0abc1234", disk_gb: "20", key_name: "ops", profile: "worker-profile", user_data: "#!/bin/sh\necho hi\n", vpc: "default", allow_destroy: "true" }],
      ["instance.plain", "@aws.EC2", "app-plain", { vpc: "default" }],
    ]);
  });

  test("a named network reaches the resource", () => {
    expect(analyzeApp(fixture("network")).instances[0]!.network).toEqual({ vpc: "vpc-0abc1234", subnets: "subnet-aaaa1111" });
  });

  test("duplicates, unknown options, a bad size and a bad image are errors", () => {
    expect(() => analyzeApp(fixture("duplicate"))).toThrow(/Instance "same" is also declared at/);
    expect(() => analyzeApp(fixture("typo"))).toThrow(/unknown Instance option "sizee" \(supported: size, image, diskGb, keyName, profile, userData, network, allowDestroy\)/);
    expect(() => analyzeApp(fixture("bad-size"))).toThrow(/Unsupported instance size "huge"/);
    expect(() => analyzeApp(fixture("bad-image"))).toThrow(/Invalid image "not-an-ami"/);
  });
});

describe("ec2 driver", () => {
  test("starts a t4g.micro from the latest Amazon Linux in the network and waits until it is running", async () => {
    const fleet = fakeFleet();
    const state = emptyState();
    await applyConfig(configWith(), state, fleet.drivers);
    const run = fleet.calls.find((c) => c.name === "RunInstancesCommand")!.input;
    expect(run).toMatchObject({ ImageId: "ami-0latest01", InstanceType: "t4g.micro", MinCount: 1, MaxCount: 1, SubnetId: "subnet-aaaa1111", SecurityGroupIds: ["sg-0def4001"], MetadataOptions: { HttpTokens: "required" } });
    expect(run.TagSpecifications[0].Tags).toEqual(expect.arrayContaining([{ Key: "Name", Value: "app-worker" }, { Key: "cloudgear:project", Value: "app" }]));
    expect("BlockDeviceMappings" in run).toBe(false);
    expect(fleet.sleeps.length).toBeGreaterThan(0);
    expect(state.entries[KEY]!.outputs).toMatchObject({ image_id: "ami-0latest01", private_ip: "10.0.0.5", public_ip: "203.0.113.7", vpc_id: "vpc-0def0001", subnet_id: "subnet-aaaa1111" });
    expect(plan(configWith(), state).every((a) => a.op === "noop")).toBe(true);
  });

  test("size, image, disk, key, profile and user data are passed on", async () => {
    const fleet = fakeFleet();
    await applyConfig(configWith({ size: "medium", image: "ami-0abc1234", disk_gb: "30", key_name: "ops", profile: "worker-profile", user_data: "#!/bin/sh\necho hi\n" }), emptyState(), fleet.drivers);
    const run = fleet.calls.find((c) => c.name === "RunInstancesCommand")!.input;
    expect(run).toMatchObject({ ImageId: "ami-0abc1234", InstanceType: "t4g.medium", KeyName: "ops", IamInstanceProfile: { Name: "worker-profile" } });
    expect(run.BlockDeviceMappings).toEqual([{ DeviceName: "/dev/xvda", Ebs: { VolumeSize: 30, VolumeType: "gp3", DeleteOnTermination: true, Encrypted: true } }]);
    expect(Buffer.from(run.UserData, "base64").toString("utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(fleet.ssmCalls()).toBe(0);
  });

  test("an existing instance with the name is adopted, and a mismatch or a duplicate is refused", async () => {
    const existing = { id: "i-0000000a", name: "app-worker", state: "running", busy: 0, type: "t4g.micro", image: "ami-0abc1234" };
    const fleet = fakeFleet([existing]);
    await applyConfig(configWith(), emptyState(), fleet.drivers);
    expect(fleet.names()).not.toContain("RunInstancesCommand");
    expect(fleet.logs).toContain("adopted existing instance app-worker");

    await expect(applyConfig(configWith({ size: "small" }), emptyState(), fakeFleet([existing]).drivers)).rejects.toThrow(/type is t4g.micro \(config: t4g.small\)/);
    await expect(applyConfig(configWith({ image: "ami-0abc9999" }), emptyState(), fakeFleet([existing]).drivers)).rejects.toThrow(/image is ami-0abc1234 \(config: ami-0abc9999\)/);
    await expect(applyConfig(configWith(), emptyState(), fakeFleet([existing, { ...existing, id: "i-0000000b" }]).drivers)).rejects.toThrow(/2 instances are named "app-worker"/);
  });

  test("a stopped instance is adopted and left stopped without waiting", async () => {
    const fleet = fakeFleet([{ id: "i-0000000a", name: "app-worker", state: "stopped", busy: 0, type: "t4g.micro", image: "ami-0abc1234" }]);
    await applyConfig(configWith(), emptyState(), fleet.drivers);
    expect(fleet.sleeps).toHaveLength(0);
    expect(fleet.logs).toContain("instance app-worker is stopped; leaving it as it is");
  });

  test("a bad network fails before anything is started", async () => {
    const fleet = fakeFleet();
    await expect(applyConfig(configWith({ vpc: "vpc-0abc1234", subnets: "subnet-dddd4444" }), emptyState(), fleet.drivers)).rejects.toThrow(/Subnets subnet-dddd4444 are not in VPC vpc-0abc1234/);
    expect(fleet.names()).not.toContain("RunInstancesCommand");
  });

  test("an instance that dies while starting, or never starts, fails clearly", async () => {
    await expect(applyConfig(configWith(), emptyState(), fakeFleet([], { dies: true }).drivers)).rejects.toThrow(/ended up terminated while starting/);
    const stuck = fakeFleet([], { stuck: true });
    await expect(applyConfig(configWith(), emptyState(), stuck.drivers)).rejects.toThrow(/still not running after 5 minutes; run apply again/);
    expect(stuck.sleeps).toHaveLength(60);
    const retry = fakeFleet([{ id: "i-0000000a", name: "app-worker", state: "pending", busy: 1, type: "t4g.micro", image: "ami-0latest01" }]);
    await applyConfig(configWith(), emptyState(), retry.drivers);
    expect(retry.names()).not.toContain("RunInstancesCommand");
  });

  test("settings that only apply at creation cannot be changed, but allowDestroy can", async () => {
    const fleet = fakeFleet();
    const state = emptyState();
    await applyConfig(configWith(), state, fleet.drivers);
    for (const change of [{ size: "small" } as Record<string, string>, { disk_gb: "20" }, { key_name: "ops" }, { user_data: "x" }, { image: "ami-0abc1234" }, { vpc: "vpc-0abc1234" }]) {
      await expect(applyConfig(configWith(change), state, fleet.drivers)).rejects.toThrow(/only apply when an instance is created; use a new name to replace it/);
    }
    await applyConfig(configWith({ allow_destroy: "true" }), state, fleet.drivers);
    expect(fleet.names().filter((n) => n === "RunInstancesCommand")).toHaveLength(1);
  });

  test("import then apply records allowDestroy only at apply", async () => {
    const fleet = fakeFleet([{ id: "i-0000000a", name: "app-worker", state: "running", busy: 0, type: "t4g.micro", image: "ami-0abc1234" }]);
    const state = emptyState();
    const config = configWith({ allow_destroy: "true" });
    expect((await adoptEntries(plan(config, state), state, fleet.drivers, () => true)).adopted).toHaveLength(1);
    await expect(applyConfig(empty(), state, fleet.drivers)).rejects.toThrow(/Nothing was changed/);
    await applyConfig(config, state, fleet.drivers);
    await applyConfig(empty(), state, fleet.drivers);
    expect(fleet.vms.get("i-0000000a")!.state).toBe("terminated");
  });

  test("destroy refuses an unprotected instance before changing anything, and terminates a protected one", async () => {
    const guarded = fakeFleet();
    const savedGuarded = emptyState();
    await applyConfig(configWith(), savedGuarded, guarded.drivers);
    await expect(applyConfig(empty(), savedGuarded, guarded.drivers)).rejects.toThrow(/^Nothing was changed\. Refusing to terminate instance "app-worker"/);
    expect([...guarded.vms.values()].every((vm) => vm.state === "running")).toBe(true);

    const open = fakeFleet();
    const savedOpen = emptyState();
    await applyConfig(configWith({ allow_destroy: "true" }), savedOpen, open.drivers);
    await applyConfig(empty(), savedOpen, open.drivers);
    expect([...open.vms.values()].map((vm) => vm.state)).toEqual(["terminated"]);
    expect(savedOpen.entries).toEqual({});
  });

  test("an instance that is already gone, or already shutting down, does not fail the delete", async () => {
    const gone = fakeFleet();
    const state = emptyState();
    await applyConfig(configWith({ allow_destroy: "true" }), state, gone.drivers);
    gone.vms.clear();
    await applyConfig(empty(), state, gone.drivers);
    expect(state.entries).toEqual({});

    const shutting = fakeFleet();
    const second = emptyState();
    await applyConfig(configWith({ allow_destroy: "true" }), second, shutting.drivers);
    const vm = [...shutting.vms.values()][0]!;
    vm.state = "shutting-down";
    vm.busy = 2;
    await applyConfig(empty(), second, shutting.drivers);
    expect(shutting.names()).not.toContain("TerminateInstancesCommand");
  });

  test("adopt reads only, records the spec when the instance matches, and explains when not", async () => {
    const fleet = fakeFleet([{ id: "i-0000000a", name: "app-worker", state: "running", busy: 0, type: "t4g.micro", image: "ami-0abc1234" }]);
    const [entry] = plan(configWith({ allow_destroy: "true" }), emptyState()).map((a) => a.desired!);
    const ok = await fleet.drivers["@aws.EC2"]!.adopt!(entry!, { entry: () => undefined });
    expect(ok!.spec).toEqual({ physical_name: "app-worker", region: "", options: { vpc: "default" } });
    expect(ok!.outputs.instance_id).toBe("i-0000000a");
    expect(fleet.names().every((n) => n === "DescribeInstancesCommand")).toBe(true);
    const [other] = plan(configWith({ size: "medium" }), emptyState()).map((a) => a.desired!);
    const mismatch = await fleet.drivers["@aws.EC2"]!.adopt!(other!, { entry: () => undefined });
    expect(mismatch!.spec).toEqual({ physical_name: "app-worker" });
    expect(mismatch!.notes![0]).toMatch(/type is t4g.micro \(config: t4g.medium\)/);
    expect(await fakeFleet().drivers["@aws.EC2"]!.adopt!(entry!, { entry: () => undefined })).toBeUndefined();
  });
});

describe("option validation", () => {
  test("EC2 options are checked", () => {
    validateOptions("aws", "@aws.EC2", { size: "small", image: "ami-0abc1234", disk_gb: "20", key_name: "ops", profile: "p", user_data: "echo", vpc: "default", allow_destroy: "true" }, "i");
    expect(() => validateOptions("aws", "@aws.EC2", { size: "huge" }, "i")).toThrow(/must be one of micro, small, medium/);
    expect(() => validateOptions("aws", "@aws.EC2", { image: "x" }, "i")).toThrow(/must be an AMI id/);
    expect(() => validateOptions("aws", "@aws.EC2", { disk_gb: "0" }, "i")).toThrow(/must be an integer from 1 to 16384/);
    expect(() => validateOptions("aws", "@aws.EC2", { user_data: "x".repeat(16385) }, "i")).toThrow(/at most 16384 bytes/);
    expect(() => validateOptions("aws", "@aws.EC2", { tier: "x" }, "i")).toThrow(/unknown option "tier"/);
  });
});
