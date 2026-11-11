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
