import type { DnsDriver } from "@cloudgear/dns";
import { edgeId } from "@cloudgear/cdn/gcp-names";
import type { SecretRefSpec } from "../../config/schema";
import type { GcpHttp } from "./http";

export interface EdgeDeps {
  http: GcpHttp;
  dns: (provider: string, zone: string, token?: SecretRefSpec) => Promise<DnsDriver>;
  sleep: (ms: number) => Promise<void>;
}

export const CERTIFICATE_MANAGER = "https://certificatemanager.googleapis.com/v1";
export const COMPUTE = "https://compute.googleapis.com/compute/v1";
export const OPERATION_ATTEMPTS = 120;
export const OPERATION_WAIT_MS = 5000;

export const statusOf = (err: unknown): number | undefined => {
  const e = err as { status?: number; code?: unknown };
  return e.status ?? (typeof e.code === "number" ? e.code : undefined);
};

export { edgeId };

// A delete refused because something still uses the resource.
export function isInUse(err: unknown): boolean {
  const status = statusOf(err);
  return status === 409 || (status === 400 && /in use|resourceInUse|being used|still referenced/i.test((err as Error).message));
}

export function sameTarget(a: string | undefined, b: string | undefined): boolean {
  const normalize = (value: string | undefined) => (value ?? "").trim().toLowerCase().replace(/\.$/, "");
  return normalize(a) === normalize(b);
}

// Waits for a Certificate Manager operation; an operation that ended in an error is an error here.
export async function waitCertificateOperation(deps: Pick<EdgeDeps, "http" | "sleep">, operation: { name?: string; done?: boolean; error?: { message?: string } }): Promise<void> {
  let current = operation;
  for (let attempt = 0; !current.done; attempt++) {
    if (attempt >= OPERATION_ATTEMPTS || !current.name) throw new Error(`Timed out waiting for ${current.name ?? "a Certificate Manager operation"}`);
    await deps.sleep(OPERATION_WAIT_MS);
    current = await deps.http.request("GET", `${CERTIFICATE_MANAGER}/${current.name}`);
  }
  if (current.error) throw new Error(current.error.message ?? "a Certificate Manager operation failed");
}

// Waits for a global Compute operation, which has its own wait call.
export async function waitComputeOperation(deps: Pick<EdgeDeps, "http" | "sleep">, project: string, operation: { name?: string; status?: string; error?: { errors?: { message?: string }[] } }): Promise<void> {
  let current = operation;
  for (let attempt = 0; current.status !== "DONE"; attempt++) {
    if (attempt >= OPERATION_ATTEMPTS || !current.name) throw new Error(`Timed out waiting for the Compute operation ${current.name ?? ""}`);
    current = await deps.http.request("POST", `${COMPUTE}/projects/${project}/global/operations/${current.name}/wait`);
  }
  if (current.error?.errors?.length) throw new Error(current.error.errors.map((e) => e.message).join("; "));
}
