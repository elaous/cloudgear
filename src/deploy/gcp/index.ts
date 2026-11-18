import type { Drivers } from "../apply";
import { gcsDriver, type StorageLike } from "./storage";

export interface GcpDeps {
  // One client per project; created on first use.
  storage: (project: string) => StorageLike;
  // The project of the credentials in use, when they name one.
  defaultProject: () => Promise<string | undefined>;
  // Resource labels; GCP label keys and values are more restricted than AWS tags.
  labels?: Record<string, string>;
  log: (message: string) => void;
  env?: Record<string, string | undefined>;
}

// Resolves the project a resource lives in: its own option, then GOOGLE_CLOUD_PROJECT, then the credentials'.
export async function resolveProject(deps: Pick<GcpDeps, "defaultProject" | "env">, option: string | undefined, what: string): Promise<string> {
  const project = option || (deps.env ?? process.env).GOOGLE_CLOUD_PROJECT || (await deps.defaultProject().catch(() => undefined));
  if (!project) {
    throw new Error(`${what} has no GCP project; set its project option, GOOGLE_CLOUD_PROJECT, or the project of your Application Default Credentials (gcloud config set project <id>)`);
  }
  return project;
}

// GCP labels: lowercase letters, digits, "_" and "-", starting with a letter, values up to 63 characters.
export function labelsFrom(tags: Record<string, string> | undefined, resource: string): Record<string, string> {
  const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 63);
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...(tags ?? {}), "cloudgear:resource": resource })) {
    const name = clean(key).replace(/^[^a-z]+/, "");
    if (name) labels[name] = clean(value);
  }
  return labels;
}

export function gcpDrivers(deps: GcpDeps): Drivers {
  return { "@gcp.GCS": gcsDriver(deps) };
}
