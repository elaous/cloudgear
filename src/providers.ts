import type { BlobAccess } from "@cloudgear/blob";

// Per provider: the flagship service each cloudgear client is inferred as,
// and the permissions each client operation needs.
export interface ProviderProfile {
  function: { type: string; runtime: string; memoryMb: number; timeoutS: number };
  blobStore: { type: string; actions: Record<BlobAccess, string[]> };
}

export const PROVIDERS: Record<string, ProviderProfile> = {
  aws: {
    function: { type: "@aws.Lambda", runtime: "nodejs22.x", memoryMb: 256, timeoutS: 10 },
    blobStore: {
      type: "@aws.S3",
      actions: {
        read: ["s3:GetObject"],
        // HeadObject on a missing key returns 403 instead of 404 without ListBucket.
        probe: ["s3:GetObject", "s3:ListBucket"],
        write: ["s3:PutObject"],
        delete: ["s3:DeleteObject"],
        list: ["s3:ListBucket"],
      },
    },
  },
};

export function providerProfile(provider: string): ProviderProfile {
  const profile = PROVIDERS[provider];
  if (!profile) {
    throw new Error(`Provider "${provider}" is not supported yet (supported: ${Object.keys(PROVIDERS).join(", ")})`);
  }
  return profile;
}
