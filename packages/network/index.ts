export { NETWORK_FIELDS } from "./schema.gen";

export type NetworkProvider = "aws";

export interface NetworkOptions {
  // An existing VPC id; omit it to use the region's default VPC.
  vpc?: string;
  // Subnet ids inside the VPC; omit them to use one subnet per availability zone.
  subnets?: string[];
  // Security group ids; omit them to use the VPC's default security group.
  securityGroups?: string[];
}

const VPC = /^vpc-[0-9a-f]{8,17}$/;
const SUBNET = /^subnet-[0-9a-f]{8,17}$/;
const SECURITY_GROUP = /^sg-[0-9a-f]{8,17}$/;

// Lambda accepts up to 16 subnets and 5 security groups.
export const MAX_SUBNETS = 16;
export const MAX_SECURITY_GROUPS = 5;

function assertIds(label: string, ids: string[] | undefined, pattern: RegExp, max: number): void {
  if (ids === undefined) return;
  if (!ids.length) throw new Error(`${label} must not be empty; omit it to use the default`);
  if (ids.length > max) throw new Error(`${label} accepts at most ${max} ids; got ${ids.length}`);
  for (const id of ids) if (!pattern.test(id)) throw new Error(`Invalid ${label.replace(/s$/, "")} id "${id}"`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} lists an id twice`);
}

// An existing network, never created or changed by cloudgear. Constructing does nothing.
export class Network {
  constructor(
    readonly provider: NetworkProvider,
    readonly options: NetworkOptions = {},
  ) {
    if (provider !== "aws") throw new Error(`Network provider "${provider}" is not supported yet (supported: aws)`);
    const { vpc, subnets, securityGroups } = options;
    if (vpc !== undefined && !VPC.test(vpc)) throw new Error(`Invalid VPC id "${vpc}"; expected an id such as "vpc-0123456789abcdef0"`);
    if (vpc === undefined && (subnets !== undefined || securityGroups !== undefined)) throw new Error("subnets and securityGroups need a vpc; omit all three to use the default VPC");
    assertIds("subnets", subnets, SUBNET, MAX_SUBNETS);
    assertIds("securityGroups", securityGroups, SECURITY_GROUP, MAX_SECURITY_GROUPS);
  }
}
