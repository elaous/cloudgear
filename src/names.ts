import { createHash } from "node:crypto";

export function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "fn";
}

// Truncates with a hash of the full name so distinct long names stay distinct.
export function fitName(name: string, max: number): string {
  if (name.length <= max) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, max - hash.length - 1)}-${hash}`;
}
