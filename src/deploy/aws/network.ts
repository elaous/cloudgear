import { DescribeSecurityGroupsCommand, DescribeSubnetsCommand, DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import type { SendClient } from "./index";

export interface ResolvedNetwork {
  vpcId: string;
  subnetIds: string[];
  securityGroupIds: string[];
}

export interface NetworkDeps {
  ec2: SendClient;
  region: string;
  log: (message: string) => void;
}

// The option keys a network is stored under, on functions and on caches.
export const NETWORK_KEYS = ["vpc", "subnets", "security_groups"] as const;

const notFound = (err: unknown, prefix: string): boolean => ((err as { name?: string }).name ?? "").startsWith(prefix);

interface Subnet {
  SubnetId: string;
  AvailabilityZone?: string;
  State?: string;
  Ipv6Native?: boolean;
  AvailableIpAddressCount?: number;
}

// Looks the VPC up so a wrong id fails before anything is created. Undefined when no vpc is set.
export async function resolveNetwork(deps: NetworkDeps, options: Record<string, string> | undefined): Promise<ResolvedNetwork | undefined> {
  const wanted = options?.vpc;
  if (!wanted) return undefined;
  let vpcs: { VpcId?: string }[];
  try {
    vpcs = (await deps.ec2.send(new DescribeVpcsCommand(wanted === "default" ? { Filters: [{ Name: "is-default", Values: ["true"] }] } : { VpcIds: [wanted] }))).Vpcs ?? [];
  } catch (err) {
    if (!notFound(err, "InvalidVpcID")) throw err;
    vpcs = [];
  }
  const vpcId = vpcs[0]?.VpcId;
  if (!vpcId) {
    throw new Error(wanted === "default" ? `There is no default VPC in ${deps.region}; declare new Network("aws", { vpc: "vpc-..." }) and pass it as the network` : `VPC ${wanted} was not found in ${deps.region}`);
  }

  const given = options?.subnets?.split(",");
  let subnets: Subnet[];
  try {
    subnets = (await deps.ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: "vpc-id", Values: [vpcId] }], ...(given ? { SubnetIds: given } : {}) }))).Subnets ?? [];
  } catch (err) {
    if (!given || !notFound(err, "InvalidSubnetID")) throw err;
    throw new Error(`Subnets ${given.join(", ")} were not found in VPC ${vpcId}`);
  }
  const missing = (given ?? []).filter((id) => !subnets.some((subnet) => subnet.SubnetId === id));
  if (missing.length) throw new Error(`Subnets ${missing.join(", ")} are not in VPC ${vpcId}`);
  // Without a choice: ordinary availability zones only, one subnet each, the one with the most free addresses.
  const usable = subnets.filter((subnet) => subnet.State !== "pending" && !subnet.Ipv6Native && /^[a-z]{2}(-[a-z]+)+-\d[a-z]$/.test(subnet.AvailabilityZone ?? ""));
  const perZone = new Map<string, Subnet>();
  for (const subnet of [...usable].sort((x, y) => (y.AvailableIpAddressCount ?? 0) - (x.AvailableIpAddressCount ?? 0) || (x.SubnetId < y.SubnetId ? -1 : 1))) {
    if (!perZone.has(subnet.AvailabilityZone!)) perZone.set(subnet.AvailabilityZone!, subnet);
  }
  const subnetIds = given ? [...given] : [...perZone.values()].map((subnet) => subnet.SubnetId).sort();
  if (!subnetIds.length) throw new Error(`VPC ${vpcId} has no subnet that can be used; name subnets with the network's subnets option`);
  if (!given) deps.log(`using subnets ${subnetIds.join(", ")} of ${vpcId}; name subnets in the network to choose others`);

  const groups = options?.security_groups?.split(",");
  let found: { GroupId: string }[];
  try {
    found = (await deps.ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: "vpc-id", Values: [vpcId] }, ...(groups ? [{ Name: "group-id", Values: groups }] : [{ Name: "group-name", Values: ["default"] }])] }))).SecurityGroups ?? [];
  } catch (err) {
    if (!groups || !notFound(err, "InvalidGroup")) throw err;
    throw new Error(`Security groups ${groups.join(", ")} were not found in VPC ${vpcId}`);
  }
  const groupIds = found.map((group) => group.GroupId);
  if (groups ? groups.some((id) => !groupIds.includes(id)) : !groupIds.length) {
    throw new Error(groups ? `Security groups ${groups.filter((id) => !groupIds.includes(id)).join(", ")} are not in VPC ${vpcId}` : `VPC ${vpcId} has no default security group; pass securityGroups`);
  }
  return { vpcId, subnetIds, securityGroupIds: groups ? [...groups] : groupIds };
}
