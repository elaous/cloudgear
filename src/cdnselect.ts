import type { CloudgearConfig } from "./config/schema";
import type { State, StateEntry } from "./deploy/state";

// Deployed non-router distributions still declared in config.
export function siteDistributions(config: CloudgearConfig, state: State): StateEntry[] {
  const declared = new Set(config.cdn.map((c) => c.domain));
  return Object.values(state.entries).filter(
    (entry) =>
      entry.type === "@aws.CloudFront" &&
      !!entry.outputs.id &&
      entry.name !== config.api?.domain &&
      (entry.spec as { bucket?: string }).bucket !== "" &&
      (declared.size === 0 || declared.has(entry.name)),
  );
}

export function pickDistribution(sites: StateEntry[], domain: string | undefined): StateEntry {
  if (!sites.length) throw new Error("No CDN has been deployed; run `cloudgear apply` first");
  const names = sites.map((entry) => entry.name).sort();
  if (domain) {
    const found = sites.find((entry) => entry.name === domain);
    if (!found) throw new Error(`No site CDN is deployed on "${domain}" (deployed: ${names.join(", ")}); the router's distribution cannot be invalidated here`);
    return found;
  }
  if (sites.length > 1) throw new Error(`Several CDNs are deployed; choose one with --domain (${names.join(", ")})`);
  return sites[0]!;
}
