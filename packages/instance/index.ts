export type InstanceProvider = "aws";
export type InstanceSize = "micro" | "small" | "medium";

export const INSTANCE_SIZES: readonly InstanceSize[] = ["micro", "small", "medium"];
export const MAX_USER_DATA_BYTES = 16384;

export interface InstanceOptions {
  // "micro", "small" or "medium" (t4g, arm64); default "micro".
  size?: InstanceSize;
  // An AMI id; omit it for the latest Amazon Linux 2023 (arm64).
  image?: string;
  // Root volume size in GB; omit it for the image's own size.
  diskGb?: number;
  // An existing key pair name, to log in with SSH.
  keyName?: string;
  // An existing instance profile name.
  profile?: string;
  // A script run at first boot, as text.
  userData?: string;
  // A Network (see @cloudgear/network); omit it for the default VPC.
  network?: { readonly provider: string };
  // Without it, `cloudgear destroy` refuses to terminate the instance.
  allowDestroy?: boolean;
}

const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;
const AMI = /^ami-[0-9a-f]{8,17}$/;
const KEY_NAME = /^[\x20-\x7E]{1,255}$/;
const PROFILE = /^[\w+=,.@-]{1,128}$/;

// Constructing does nothing; `cloudgear apply` creates or adopts the instance.
export class Instance {
  constructor(
    readonly provider: InstanceProvider,
    readonly name: string,
    readonly options: InstanceOptions = {},
  ) {
    if (provider !== "aws") throw new Error(`Instance provider "${provider}" is not supported yet (supported: aws)`);
    if (!INSTANCE_NAME.test(name)) throw new Error(`Invalid instance name "${name}"; use 1-128 letters, digits, spaces, ".", "_" or "-"`);
    const { size, image, diskGb, keyName, profile, userData } = options;
    if (size !== undefined && !INSTANCE_SIZES.includes(size)) throw new Error(`Unsupported instance size "${size}" (supported: ${INSTANCE_SIZES.join(", ")})`);
    if (image !== undefined && !AMI.test(image)) throw new Error(`Invalid image "${image}"; expected an AMI id such as "ami-0123456789abcdef0"`);
    if (diskGb !== undefined && (!Number.isInteger(diskGb) || diskGb < 1 || diskGb > 16384)) throw new Error(`diskGb must be a whole number from 1 to 16384; got ${diskGb}`);
    if (keyName !== undefined && !KEY_NAME.test(keyName)) throw new Error(`Invalid keyName "${keyName}"`);
    if (profile !== undefined && !PROFILE.test(profile)) throw new Error(`Invalid profile "${profile}"`);
    if (userData !== undefined && new TextEncoder().encode(userData).length > MAX_USER_DATA_BYTES) throw new Error(`userData is over ${MAX_USER_DATA_BYTES} bytes`);
  }
}
