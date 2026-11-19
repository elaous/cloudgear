import type { FunctionComparable } from "../plan";
import type { GcpApiError } from "./http";
import type { StorageLike } from "./storage";

// One role on one bucket, optionally only for object names under a prefix.
export interface Grant {
  bucket: string;
  role: string;
  path: string;
}

export const grantId = (grant: Grant): string => `${grant.bucket}|${grant.role}|${grant.path}`;
export const parseGrant = (id: string): Grant => {
  const [bucket = "", role = "", ...path] = id.split("|");
  return { bucket, role, path: path.join("|") };
};

// The smallest predefined roles that cover the permissions. Viewer includes list, and a delete needs the broader object user role (which also allows overwrites).
export function rolesFor(actions: string[]): string[] {
  const known = new Set(["storage.objects.get", "storage.objects.list", "storage.objects.create", "storage.objects.delete"]);
  const unknown = actions.filter((action) => !known.has(action));
  if (unknown.length) throw new Error(`No GCS role covers ${unknown.join(", ")}`);
  if (actions.includes("storage.objects.delete")) return ["roles/storage.objectUser"];
  return [
    ...(actions.includes("storage.objects.get") || actions.includes("storage.objects.list") ? ["roles/storage.objectViewer"] : []),
    ...(actions.includes("storage.objects.create") ? ["roles/storage.objectCreator"] : []),
  ];
}

// What a function's permissions ask for on GCS buckets; other providers' stores are not granted here.
export function desiredGrants(permissions: FunctionComparable["permissions"]): Grant[] {
  const grants = new Map<string, Grant>();
  for (const permission of permissions) {
    if (permission.type !== "@gcp.GCS") continue;
    if ([...permission.path].some((ch) => ch === '"' || ch === "\\" || ch.charCodeAt(0) < 32)) throw new Error(`The path "${permission.path}" on bucket ${permission.physical_name} has characters a GCS access condition cannot hold`);
    for (const role of rolesFor(permission.actions)) {
      const grant = { bucket: permission.physical_name, role, path: permission.path };
      grants.set(grantId(grant), grant);
    }
  }
  return [...grants.values()].sort((a, b) => (grantId(a) < grantId(b) ? -1 : 1));
}

const conditionFor = (grant: Grant) =>
  grant.path ? { title: [...`cloudgear: ${grant.path}`].slice(0, 100).join(""), expression: `resource.name.startsWith("projects/_/buckets/${grant.bucket}/objects/${grant.path}")` } : undefined;

// Adds or removes one member's binding, leaving every other binding as it is.
// Returns whether the policy was changed: false when the member already had (or already lacked) the binding.
export async function changeGrant(storage: StorageLike, grant: Grant, member: string, add: boolean): Promise<boolean> {
  const bucket = storage.bucket(grant.bucket);
  const condition = conditionFor(grant);
  for (let attempt = 0; ; attempt++) {
    let policy: Awaited<ReturnType<typeof bucket.iam.getPolicy>>[0];
    try {
      [policy] = await bucket.iam.getPolicy({ requestedPolicyVersion: 3 });
    } catch (err) {
      if (!add && (err as GcpApiError).status === 404) return false;
      if (!add && (err as { code?: number }).code === 404) return false;
      throw err;
    }
    const bindings = (policy.bindings ?? []).map((b) => ({ ...b, members: [...b.members] }));
    const match = bindings.find((b) => b.role === grant.role && (b.condition?.expression ?? "") === (condition?.expression ?? ""));
    if (add) {
      if (match?.members.includes(member)) return false;
      if (match) match.members.push(member);
      else bindings.push({ role: grant.role, members: [member], ...(condition ? { condition } : {}) });
    } else {
      if (!match?.members.includes(member)) return false;
      match.members = match.members.filter((m) => m !== member);
    }
    const next = { ...policy, bindings: bindings.filter((b) => b.members.length), ...(condition || bindings.some((b) => b.condition) ? { version: 3 } : {}) };
    try {
      await bucket.iam.setPolicy(next);
      return true;
    } catch (err) {
      // Someone else changed the policy between the read and the write.
      const status = (err as { code?: number }).code ?? (err as GcpApiError).status;
      if (attempt >= 2 || (status !== 409 && status !== 412)) throw err;
    }
  }
}
