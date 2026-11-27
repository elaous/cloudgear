import { createHash } from "node:crypto";

function trimHyphens(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "-") end--;
  return text.slice(0, end);
}

// The id of a GCP edge resource for a domain: lowercase letters, digits and hyphens, at most 63 characters, unique per domain.
export function edgeId(domain: string, suffix = "", max = 63): string {
  const readable = trimHyphens(`cg-${domain.replace(/^\*\./, "wildcard-")}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  // The hash of the raw domain keeps names that sanitize alike apart.
  const hash = createHash("sha256").update(domain.toLowerCase()).digest("hex").slice(0, 8);
  const room = max - suffix.length - hash.length - 1;
  return `${trimHyphens(readable.slice(0, room))}-${hash}${suffix}`;
}
