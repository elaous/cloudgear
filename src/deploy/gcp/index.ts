import type { Drivers } from "../apply";
import { functionDriver, type FunctionDeps } from "./functions";
import { gcsDriver, type StorageLike } from "./storage";

export interface GcpDeps {
  // A client for a project, reused for the rest of the run.
  storage: (project: string) => StorageLike;
  // The project of the credentials in use, when they name one.
  defaultProject: () => Promise<string | undefined>;
  // Resource labels; GCP label keys and values are more restricted than AWS tags.
  labels?: Record<string, string>;
  log: (message: string) => void;
  env?: Record<string, string | undefined>;
  // Present when the functions can deploy.
  functions?: FunctionDeps;
}

// Resolves the project a resource lives in: its own option, then GOOGLE_CLOUD_PROJECT, then the credentials'.
export async function resolveProject(deps: Pick<GcpDeps, "defaultProject" | "env">, option: string | undefined, what: string): Promise<string> {
  const given = option || (deps.env ?? process.env).GOOGLE_CLOUD_PROJECT;
  if (given) return given;
  let failure: string | undefined;
  const found = await deps.defaultProject().catch((err: Error) => {
    failure = err.message;
    return undefined;
  });
  if (!found) {
    throw new Error(
      `${what} has no GCP project; set its project option, GOOGLE_CLOUD_PROJECT, or the project of your Application Default Credentials (gcloud config set project <id>)${failure ? ` (looking it up failed: ${failure})` : ""}`,
    );
  }
  return found;
}

// GCP labels: lowercase letters, digits, "_" and "-", starting with a letter, values up to 63 characters.
// Two tags that become the same label are an error; silently dropping one would hide a tag.
export function labelsFrom(tags: Record<string, string> | undefined, resource: string): Record<string, string> {
  const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 63);
  const labels: Record<string, string> = {};
  const source: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...(tags ?? {}), "cloudgear:resource": resource })) {
    const name = clean(key).replace(/^[^a-z]+/, "");
    if (!name) throw new Error(`Tag "${key}" cannot become a GCP label; give it a key that contains a letter`);
    if (name.startsWith("goog")) throw new Error(`Tag "${key}" would become the label "${name}"; GCP reserves the "goog" prefix`);
    if (source[name] !== undefined && source[name] !== key) throw new Error(`Tags "${source[name]}" and "${key}" both become the GCP label "${name}"; rename one`);
    source[name] = key;
    labels[name] = clean(value);
  }
  return labels;
}

export function gcpDrivers(deps: GcpDeps): Drivers {
  return { "@gcp.GCS": gcsDriver(deps), ...(deps.functions ? { "@gcp.CloudFunction": functionDriver(deps, deps.functions) } : {}) };
}
