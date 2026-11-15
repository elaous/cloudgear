export type RegistryProvider = "aws";

export const DEFAULT_KEEP_UNTAGGED_DAYS = 14;

export interface RegistryOptions {
  // Default true.
  scanOnPush?: boolean;
  // Default false: tags can be moved.
  immutableTags?: boolean;
  // Days before untagged images expire (default 14); false leaves lifecycle policies alone.
  keepUntaggedDays?: number | false;
  // Without it, `cloudgear destroy` refuses to delete the repository and its images.
  allowDestroy?: boolean;
}

const REPOSITORY = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function assertRepositoryName(name: string): void {
  if (name.length < 2 || name.length > 256 || !REPOSITORY.test(name)) {
    throw new Error(`Invalid repository name "${name}"; use 2-256 lowercase letters, digits, ".", "_", "-" and "/" between words`);
  }
}

// Constructing does nothing; `cloudgear apply` creates or adopts the repository.
export class Registry {
  constructor(
    readonly provider: RegistryProvider,
    readonly name: string,
    readonly options: RegistryOptions = {},
  ) {
    if (provider !== "aws") throw new Error(`Registry provider "${provider}" is not supported yet (supported: aws)`);
    assertRepositoryName(name);
    const days = options.keepUntaggedDays;
    if (days !== undefined && days !== false && (!Number.isInteger(days) || days < 1 || days > 365)) {
      throw new Error(`keepUntaggedDays must be a whole number from 1 to 365, or false; got ${days}`);
    }
  }
}
