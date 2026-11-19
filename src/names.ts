import { createHash } from "node:crypto";

export function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "fn";
}

// Long names truncate with a hash of the full name.
export function fitName(name: string, max: number): string {
  if (name.length <= max) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, max - hash.length - 1)}-${hash}`;
}

// ElastiCache ids: lowercase letters, digits and single hyphens, starting with a letter, at most 40 characters.
export function cacheIdFor(project: string, name: string): string {
  const id = `${project}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return fitName(/^[a-z]/.test(id) ? id : `c-${id}`, 40).replace(/-{2,}/g, "-").replace(/-+$/g, "");
}

// Cloud Functions ids: lowercase letters, digits and hyphens, starting with a letter, at most 63 characters.
export function gcpFunctionIdFor(project: string, name: string): string {
  const id = `${project}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return fitName(/^[a-z]/.test(id) ? id : `f-${id}`, 63).replace(/-{2,}/g, "-").replace(/-+$/g, "");
}
