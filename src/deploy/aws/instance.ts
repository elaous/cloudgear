import { DescribeImagesCommand, DescribeInstancesCommand, RunInstancesCommand, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import type { Adopted, Driver } from "../apply";
import type { DesiredEntry } from "../plan";
import { destroyAllowed, withoutAllowDestroy } from "../protect";
import type { StateEntry } from "../state";
import type { SendClient } from "./index";
import { NETWORK_KEYS, resolveNetwork, type ResolvedNetwork } from "./network";
import { TAG_PREFIX, tagList, type Tagger } from "./tags";

export interface InstanceDeps {
  ec2: SendClient;
  ssm: SendClient;
  region: string;
  tags?: Tagger;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
}

const INSTANCE_TYPES: Record<string, string> = { micro: "t4g.micro", small: "t4g.small", medium: "t4g.medium" };
const LATEST_IMAGE = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64";
const LIVE_STATES = ["pending", "running", "stopping", "stopped"];
const WAIT_ATTEMPTS = 60;
const WAIT_MS = 5000;

// Applied only when the instance is created.
const FIXED_OPTIONS = ["size", "image", "disk_gb", "key_name", "profile", "user_data", ...NETWORK_KEYS];

interface Live {
  id: string;
  state: string;
  type?: string;
  image?: string;
  zone?: string;
  privateIp?: string;
  publicIp?: string;
  publicDns?: string;
  vpcId?: string;
  subnetId?: string;
  securityGroupIds?: string[];
  createdByCloudgear: boolean;
}

const MANAGED_TAG = `${TAG_PREFIX}managed-by`;

const optionsOf = (spec: Record<string, unknown>): Record<string, string> => (spec.options ?? {}) as Record<string, string>;
const typeFor = (spec: Record<string, unknown>): string => INSTANCE_TYPES[optionsOf(spec).size ?? "micro"]!;
const named = (err: unknown, ...names: string[]): boolean => names.includes((err as { name?: string }).name ?? "");

const outputsOf = (live: Live): Record<string, string> => ({
  instance_id: live.id,
  vpc_id: live.vpcId ?? "",
  subnet_id: live.subnetId ?? "",
  security_group_ids: (live.securityGroupIds ?? []).join(","),
  image_id: live.image ?? "",
  zone: live.zone ?? "",
  private_ip: live.privateIp ?? "",
  public_ip: live.publicIp ?? "",
  public_dns: live.publicDns ?? "",
});

const refusal = (current: StateEntry): string | undefined =>
  destroyAllowed(current) ? undefined : `Refusing to terminate instance "${current.physical_name}": its disk is deleted with it. Declare it with allowDestroy: true, apply, then remove it.`;

function differences(live: Live, spec: Record<string, unknown>): string[] {
  const options = optionsOf(spec);
  return [
    ...(live.type && live.type !== typeFor(spec) ? [`type is ${live.type} (config: ${typeFor(spec)})`] : []),
    ...(options.image && live.image && live.image !== options.image ? [`image is ${live.image} (config: ${options.image})`] : []),
  ];
}

export function instanceDriver(deps: InstanceDeps): Driver {
  const fromApi = (instance: Record<string, any>): Live => ({
    id: instance.InstanceId,
    state: instance.State?.Name ?? "",
    type: instance.InstanceType,
    image: instance.ImageId,
    zone: instance.Placement?.AvailabilityZone,
    privateIp: instance.PrivateIpAddress,
    publicIp: instance.PublicIpAddress,
    publicDns: instance.PublicDnsName || undefined,
    vpcId: instance.VpcId,
    subnetId: instance.SubnetId,
    securityGroupIds: (instance.SecurityGroups ?? []).map((group: { GroupId: string }) => group.GroupId),
    createdByCloudgear: ((instance.Tags ?? []) as { Key: string; Value: string }[]).some((tag) => tag.Key === MANAGED_TAG && tag.Value === "cloudgear"),
  });

  async function findByName(name: string): Promise<Live | undefined> {
    const res = await deps.ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "tag:Name", Values: [name] }, { Name: "instance-state-name", Values: LIVE_STATES }] }));
    const found = ((res.Reservations ?? []) as { Instances?: Record<string, any>[] }[]).flatMap((r) => r.Instances ?? []).map(fromApi);
    if (found.length > 1) throw new Error(`${found.length} instances are named "${name}" (${found.map((i) => i.id).join(", ")}); rename or terminate the extras so cloudgear knows which one to manage`);
    return found[0];
  }

  async function findById(id: string): Promise<Live | undefined> {
    try {
      const res = await deps.ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }));
      const instance = ((res.Reservations ?? []) as { Instances?: Record<string, any>[] }[]).flatMap((r) => r.Instances ?? [])[0];
      return instance ? fromApi(instance) : undefined;
    } catch (err) {
      if (named(err, "InvalidInstanceID.NotFound")) return undefined;
      throw err;
    }
  }

  async function waitFor(id: string, wanted: "running" | "terminated"): Promise<Live | undefined> {
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
      const live = await findById(id);
      if (wanted === "terminated" && (!live || live.state === "terminated")) return live;
      if (wanted === "running") {
        // EC2 can take a few seconds to show an instance that was just started.
        if (!live && attempt < 12) {
          await deps.sleep(WAIT_MS);
          continue;
        }
        if (!live || live.state === "terminated" || live.state === "shutting-down") throw new Error(`Instance ${id} ended up ${live?.state ?? "gone"} while starting; check the console for the reason`);
        if (live.state === "running") return live;
      }
      await deps.sleep(WAIT_MS);
    }
    throw new Error(`Instance ${id} is still not ${wanted} after ${(WAIT_ATTEMPTS * WAIT_MS) / 60000} minutes; run apply again`);
  }

  async function imageFor(options: Record<string, string>): Promise<string> {
    if (options.image) return options.image;
    const value = (await deps.ssm.send(new GetParameterCommand({ Name: LATEST_IMAGE }))).Parameter?.Value as string | undefined;
    if (!value) throw new Error(`Could not find the latest Amazon Linux image in ${deps.region}; name one with the image option`);
    return value;
  }

  async function start(entry: DesiredEntry, options: Record<string, string>, network: ResolvedNetwork): Promise<string> {
    const name = entry.physical_name;
    const imageId = await imageFor(options);
    let blockDevices: { DeviceName: string; Ebs: Record<string, unknown> }[] | undefined;
    if (options.disk_gb) {
      const image = ((await deps.ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }))).Images ?? [])[0] as { RootDeviceName?: string } | undefined;
      if (!image?.RootDeviceName) throw new Error(`Image ${imageId} has no root device to size; leave diskGb out`);
      blockDevices = [{ DeviceName: image.RootDeviceName, Ebs: { VolumeSize: Number(options.disk_gb), VolumeType: "gp3", DeleteOnTermination: true, Encrypted: true } }];
    }
    // The Name tag is how the instance is found again, so no other tag may use it.
    const tags = [{ Key: "Name", Value: name }, ...(deps.tags ? tagList(deps.tags(entry.name)).filter((tag) => tag.Key !== "Name") : [])];
    // Not every zone offers every type; the next subnet is tried when one does not.
    let lastError: unknown;
    for (const subnetId of network.subnetIds) {
      try {
        const started = await deps.ec2.send(
          new RunInstancesCommand({
            ImageId: imageId,
            InstanceType: typeFor(entry.spec) as never,
            MinCount: 1,
            MaxCount: 1,
            SubnetId: subnetId,
            SecurityGroupIds: network.securityGroupIds,
            MetadataOptions: { HttpTokens: "required" },
            TagSpecifications: [
              { ResourceType: "instance", Tags: tags },
              { ResourceType: "volume", Tags: tags },
            ],
            ...(blockDevices ? { BlockDeviceMappings: blockDevices as never } : {}),
            ...(options.key_name ? { KeyName: options.key_name } : {}),
            ...(options.profile ? { IamInstanceProfile: { Name: options.profile } } : {}),
            ...(options.user_data ? { UserData: Buffer.from(options.user_data, "utf8").toString("base64") } : {}),
          }),
        );
        const id = started.Instances?.[0]?.InstanceId as string | undefined;
        if (!id) throw new Error(`Starting instance "${name}" returned no instance`);
        deps.log(`started instance ${name} (${id})`);
        return id;
      } catch (err) {
        if (!named(err, "Unsupported", "InsufficientInstanceCapacity")) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  // `current` is set when cloudgear already manages the instance.
  async function ensure(entry: DesiredEntry, current?: StateEntry): Promise<Record<string, string>> {
    const name = entry.physical_name;
    const options = optionsOf(entry.spec);
    // Looked up first so a wrong network fails before anything is created.
    const network = await resolveNetwork({ ec2: deps.ec2, region: deps.region, log: deps.log }, Object.fromEntries(NETWORK_KEYS.flatMap((key) => (options[key] !== undefined ? [[key, options[key]!]] : []))));
    if (!network) throw new Error(`Instance "${entry.name}" has no network; this is a bug in the generated config`);
    const recorded = current?.outputs.instance_id;
    let live = recorded ? await findById(recorded) : await findByName(name);
    if (recorded && (!live || live.state === "terminated")) {
      throw new Error(`Instance "${name}" (${recorded}) no longer exists; remove its entry from .cloudgear/state.json to start a new one`);
    }
    if (live) {
      if (!recorded && !live.createdByCloudgear) {
        throw new Error(`An instance named "${name}" (${live.id}) exists that cloudgear did not start; run \`cloudgear import\` to adopt it, or use another name`);
      }
      const problems = differences(live, entry.spec);
      if (problems.length) throw new Error(`Instance "${name}" already exists but its ${problems.join(" and ")}; AWS cannot change that without replacing it, so use a new name`);
      deps.log(`adopted existing instance ${name}`);
      // Stopped on purpose; cloudgear does not start it.
      if (live.state === "stopped" || live.state === "stopping") {
        deps.log(`instance ${name} is ${live.state}; leaving it as it is`);
        return outputsOf(live);
      }
    } else {
      live = { id: await start(entry, options, network), state: "pending", createdByCloudgear: true };
    }
    return outputsOf((await waitFor(live.id, "running"))!);
  }

  return {
    create: (entry) => ensure(entry),
    async update(entry, current) {
      const before = optionsOf(current.spec);
      const after = optionsOf(entry.spec);
      // An imported entry records no options until its first apply.
      const changed = current.spec.options ? FIXED_OPTIONS.filter((key) => before[key] !== after[key]) : [];
      if (changed.length) throw new Error(`Instance "${entry.physical_name}": ${changed.join(", ")} only apply when an instance is created; use a new name to replace it`);
      return ensure(entry, current);
    },
    protect: refusal,
    async delete(current) {
      const reason = refusal(current);
      if (reason) throw new Error(reason);
      const live = current.outputs.instance_id ? await findById(current.outputs.instance_id) : await findByName(current.physical_name);
      if (live && live.state !== "terminated") {
        if (live.state !== "shutting-down") {
          try {
            await deps.ec2.send(new TerminateInstancesCommand({ InstanceIds: [live.id] }));
          } catch (err) {
            if (!named(err, "InvalidInstanceID.NotFound")) throw err;
          }
          deps.log(`terminating instance ${current.physical_name} (${live.id})`);
        }
        await waitFor(live.id, "terminated");
      }
    },
    // Read only; an instance that differs is recorded without its spec so the next plan shows the change.
    async adopt(entry): Promise<Adopted | undefined> {
      const live = await findByName(entry.physical_name);
      if (!live) return undefined;
      const problems = differences(live, entry.spec);
      return problems.length
        ? { outputs: outputsOf(live), spec: { physical_name: entry.physical_name }, notes: [`instance "${entry.physical_name}": ${problems.join("; ")}; AWS cannot change that without replacing it`] }
        : { outputs: outputsOf(live), spec: withoutAllowDestroy(entry.spec) };
    },
  };
}
