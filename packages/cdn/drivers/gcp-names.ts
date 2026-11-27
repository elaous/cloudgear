import { createHash } from "node:crypto";

// The id of a GCP edge resource for a domain: lowercase letters, digits and hyphens, at most 63 characters.
export function edgeId(domain: string, suffix = "", max = 63): string {
  const base = `cg-${domain.replace(/^\*\./, "wildcard-")}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/g, "");
  const room = max - suffix.length;
  const fitted = base.length <= room ? base : `${base.slice(0, room - 9)}-${createHash("sha256").update(base).digest("hex").slice(0, 8)}`;
  return `${fitted}${suffix}`.replace(/-{2,}/g, "-");
}
