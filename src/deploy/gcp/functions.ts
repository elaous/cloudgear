import { zip } from "../../build/zip";
import type { FunctionSpec } from "../../config/schema";
import { fitName } from "../../names";
import { environmentOptions } from "../../providers";
import type { Adopted, Driver, DriverContext } from "../apply";
import { resolveOutputReferences } from "../environment";
import type { DesiredEntry, FunctionComparable } from "../plan";
import type { StateEntry } from "../state";
import type { GcpApiError, GcpHttp } from "./http";
import { labelsFrom, resolveProject, type GcpDeps } from "./index";

export interface FunctionDeps {
  http: GcpHttp;
  region?: string;
  readBundle: (fn: FunctionSpec) => Uint8Array;
  readIncluded?: (fn: FunctionSpec) => { name: string; data: Uint8Array }[];
  sleep: (ms: number) => Promise<void>;
}

const FUNCTIONS = "https://cloudfunctions.googleapis.com/v2";
const RUN = "https://run.googleapis.com/v2";
const IAM = "https://iam.googleapis.com/v1";
const OPERATION_ATTEMPTS = 120;
const OPERATION_WAIT_MS = 5000;
const PROPAGATION_ATTEMPTS = 10;
const PROPAGATION_WAIT_MS = 4000;
const SERVICE_ACCOUNT_LABEL = "cloudgear_service_account";

const optionsOf = (spec: Record<string, unknown>): Record<string, string> => (spec.options ?? {}) as Record<string, string>;
const statusOf = (err: unknown): number | undefined => (err as GcpApiError).status;

// A long-running operation that finished with an error: the work definitely did not happen.
class OperationFailed extends Error {}

interface Inspected {
  state: string;
  url: string;
  email: string;
  service: string;
  labels: Record<string, string>;
  messages: string;
}

// A service account id is 6 to 30 characters, lowercase letters, digits and hyphens.
export function serviceAccountIdFor(functionId: string): string {
  return fitName(`cg-${functionId}`, 30).replace(/-{2,}/g, "-").replace(/-+$/g, "");
}

export function functionDriver(deps: GcpDeps, fns: FunctionDeps): Driver {
  const region = (): string => {
    if (!fns.region) throw new Error("Set the router's region option, --region or GOOGLE_CLOUD_REGION to deploy to GCP");
    return fns.region;
  };
  const nameOf = (project: string, id: string) => `projects/${project}/locations/${region()}/functions/${id}`;
  const projectFor = (spec: Record<string, unknown>, id: string) => resolveProject(deps, optionsOf(spec).project, `Function "${id}"`);

  async function poll(operationName: string): Promise<{ done?: boolean; error?: { message?: string } }> {
    // A passing server error should not abandon a build that is still running.
    for (let attempt = 0; ; attempt++) {
      try {
        return await fns.http.request("GET", `${FUNCTIONS}/${operationName}`);
      } catch (err) {
        const status = statusOf(err);
        if (attempt >= 2 || status === undefined || status < 500) throw err;
        await fns.sleep(OPERATION_WAIT_MS);
      }
    }
  }

  async function waitFor(operation: { name?: string; done?: boolean; error?: { message?: string } }, what: string): Promise<void> {
    let current = operation;
    for (let attempt = 0; attempt < OPERATION_ATTEMPTS; attempt++) {
      if (current.done) {
        if (current.error) throw new OperationFailed(`${what} failed: ${current.error.message ?? "unknown error"}`);
        return;
      }
      await fns.sleep(OPERATION_WAIT_MS);
      current = await poll(operation.name!);
    }
    throw new Error(`${what} is still running after ${(OPERATION_ATTEMPTS * OPERATION_WAIT_MS) / 60000} minutes; it is left running, so run apply again`);
  }

  // A new service account takes a few seconds to be usable.
  async function retried<T>(run: () => Promise<T>, email: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (err) {
        const status = statusOf(err);
        if (attempt >= PROPAGATION_ATTEMPTS || (status !== 400 && status !== 403 && status !== 404) || !(err as Error).message.includes(email)) throw err;
        await fns.sleep(PROPAGATION_WAIT_MS);
      }
    }
  }

  async function upload(project: string, source: FunctionSpec): Promise<{ bucket: string; object: string; generation?: string }> {
    const grant = await fns.http.request("POST", `${FUNCTIONS}/projects/${project}/locations/${region()}/functions:generateUploadUrl`, {});
    const files = [
      { name: "index.mjs", data: fns.readBundle(source) },
      { name: "package.json", data: new TextEncoder().encode(JSON.stringify({ type: "module", main: "index.mjs" })) },
      ...(fns.readIncluded?.(source) ?? []),
    ];
    await fns.http.upload(grant.uploadUrl, zip(files), { "content-type": "application/zip" });
    return grant.storageSource;
  }

  function serviceConfig(spec: FunctionComparable, context: DriverContext | undefined, email?: string) {
    const options = spec.options ?? {};
    return {
      availableMemory: `${spec.memory_mb}Mi`,
      timeoutSeconds: spec.timeout_s,
      environmentVariables: { ...resolveOutputReferences(spec.env, context), ...environmentOptions(spec.options) },
      ...(options.max_instances ? { maxInstanceCount: Number(options.max_instances) } : {}),
      ...(email ? { serviceAccountEmail: email, ingressSettings: "ALLOW_ALL", allTrafficOnLatestRevision: true } : {}),
    };
  }

  // Adds or removes allUsers on one resource's invoker role, leaving conditional bindings alone.
  async function setInvoker(base: string, resource: string, role: string, open: boolean): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const policy = (await fns.http.request("GET", `${base}/${resource}:getIamPolicy?options.requestedPolicyVersion=3`)) as { bindings?: { role: string; members?: string[]; condition?: unknown }[] };
      const bindings = (policy.bindings ?? []).map((b) => ({ ...b, members: [...(b.members ?? [])] }));
      const existing = bindings.find((b) => b.role === role && !b.condition);
      if (open === (existing?.members.includes("allUsers") ?? false)) return;
      if (open) {
        if (existing) existing.members.push("allUsers");
        else bindings.push({ role, members: ["allUsers"] });
      } else if (existing) {
        existing.members = existing.members.filter((m) => m !== "allUsers");
      }
      try {
        await fns.http.request("POST", `${base}/${resource}:setIamPolicy`, { policy: { ...policy, bindings: bindings.filter((b) => b.members.length) } });
        return;
      } catch (err) {
        // Someone else changed the policy between the read and the write.
        if (attempt >= 1 || (statusOf(err) !== 409 && statusOf(err) !== 412)) throw err;
      }
    }
  }

  // 2nd gen functions run on Cloud Run, so access is set on both.
  async function setPublic(name: string, service: string, open: boolean): Promise<void> {
    await setInvoker(FUNCTIONS, name, "roles/cloudfunctions.invoker", open);
    if (service) await setInvoker(RUN, service, "roles/run.invoker", open);
  }

  async function inspect(name: string): Promise<Inspected | undefined> {
    try {
      const found = await fns.http.request("GET", `${FUNCTIONS}/${name}`);
      return {
        state: found.state ?? "ACTIVE",
        url: found.url ?? found.serviceConfig?.uri ?? "",
        email: found.serviceConfig?.serviceAccountEmail ?? "",
        service: found.serviceConfig?.service ?? "",
        labels: found.labels ?? {},
        messages: (found.stateMessages ?? []).map((m: { message?: string }) => m.message).filter(Boolean).join("; "),
      };
    } catch (err) {
      if (statusOf(err) === 404) return undefined;
      throw err;
    }
  }

  async function ensureServiceAccount(project: string, id: string, label: string): Promise<{ email: string; created: boolean }> {
    const accountId = serviceAccountIdFor(id);
    const email = `${accountId}@${project}.iam.gserviceaccount.com`;
    try {
      await fns.http.request("POST", `${IAM}/projects/${project}/serviceAccounts`, { accountId, serviceAccount: { displayName: `cloudgear: ${label}`.slice(0, 100) } });
      return { email, created: true };
    } catch (err) {
      if (statusOf(err) === 409) return { email, created: false };
      throw err;
    }
  }

  async function removeServiceAccount(project: string, email: string): Promise<void> {
    try {
      await fns.http.request("DELETE", `${IAM}/projects/${project}/serviceAccounts/${email}`);
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
  }

  async function removeFunction(name: string): Promise<void> {
    try {
      await waitFor(await fns.http.request("DELETE", `${FUNCTIONS}/${name}`), `deleting ${name}`);
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
  }

  // Waits out a deploy that is still running; a function that is not ACTIVE afterwards is an error.
  async function settled(name: string): Promise<Inspected> {
    for (let attempt = 0; attempt < OPERATION_ATTEMPTS; attempt++) {
      const live = await inspect(name);
      if (!live) throw new Error(`Function ${name} disappeared while waiting for it`);
      if (live.state === "ACTIVE") return live;
      if (live.state !== "DEPLOYING") throw new Error(`Function ${name} is ${live.state}${live.messages ? `: ${live.messages}` : ""}`);
      await fns.sleep(OPERATION_WAIT_MS);
    }
    throw new Error(`Function ${name} is still deploying after ${(OPERATION_ATTEMPTS * OPERATION_WAIT_MS) / 60000} minutes; run apply again`);
  }

  const labelsOf = (entryName: string) => labelsFrom(deps.labels, entryName);
  const ownedBy = (live: Inspected, entryName: string): boolean => live.labels.cloudgear_resource === labelsFrom(undefined, entryName).cloudgear_resource && live.labels["cloudgear_managed-by"] === "cloudgear";

  return {
    async create(entry: DesiredEntry, context) {
      const spec = entry.spec as unknown as FunctionComparable;
      const source = entry.source as FunctionSpec;
      const id = entry.physical_name;
      const project = await projectFor(entry.spec, id);
      const name = nameOf(project, id);
      let serviceAccountCreatedBefore = false;

      const existing = await inspect(name);
      if (existing) {
        if (!ownedBy(existing, entry.name)) {
          throw new Error(`A function named "${id}" exists that cloudgear did not deploy; run \`cloudgear import\` to adopt it, or use another name`);
        }
        serviceAccountCreatedBefore = existing.labels[SERVICE_ACCOUNT_LABEL] === "created";
        if (existing.state === "FAILED" || existing.state === "UNKNOWN") {
          // A deploy that failed earlier; remove it and start again.
          await removeFunction(name);
        } else {
          // Left running by an earlier apply that gave up waiting.
          const live = await settled(name);
          await setPublic(name, live.service, spec.auth === "none");
          deps.log(`adopted function ${id}, which an earlier apply left deploying`);
          return { name, url: live.url, project, region: region(), service_account: live.email, service_account_created: String(serviceAccountCreatedBefore) };
        }
      }

      const account = await ensureServiceAccount(project, id, entry.name);
      const serviceAccountCreated = account.created || serviceAccountCreatedBefore;
      let started = false;
      try {
        const storageSource = await upload(project, source);
        const body = {
          environment: "GEN_2",
          labels: { ...labelsOf(entry.name), [SERVICE_ACCOUNT_LABEL]: serviceAccountCreated ? "created" : "existing" },
          buildConfig: { runtime: spec.runtime, entryPoint: "handler", source: { storageSource } },
          serviceConfig: serviceConfig(spec, context, account.email),
        };
        const operation = await retried(() => fns.http.request("POST", `${FUNCTIONS}/projects/${project}/locations/${region()}/functions?functionId=${id}`, body), account.email);
        started = true;
        await waitFor(operation, `deploying ${id}`);
        const live = await settled(name);
        // A new function is private; only a public one needs a binding.
        if (spec.auth === "none") await setPublic(name, live.service, true);
        deps.log(`deployed function ${id}`);
        return { name, url: live.url, project, region: region(), service_account: account.email, service_account_created: String(serviceAccountCreated) };
      } catch (err) {
        // Clean up only after a definite failure. A timeout or a passing error leaves the deploy running for the next apply to pick up.
        const definite = !started || err instanceof OperationFailed;
        const someoneElses = err instanceof OperationFailed && /already exists/i.test(err.message);
        if (definite && !someoneElses) {
          const removed = started ? await removeFunction(name).then(() => true, () => false) : true;
          // The account is deleted only when nothing uses it any more.
          if (removed && serviceAccountCreated) await removeServiceAccount(project, account.email).catch(() => undefined);
        } else if (definite && account.created) {
          await removeServiceAccount(project, account.email).catch(() => undefined);
        }
        throw err;
      }
    },

    async update(entry, current, changes, context) {
      const spec = entry.spec as unknown as FunctionComparable;
      const source = entry.source as FunctionSpec;
      const id = entry.physical_name;
      const project = current.outputs.project || (await projectFor(entry.spec, id));
      const wanted = optionsOf(entry.spec).project;
      if (wanted && current.outputs.project && wanted !== current.outputs.project) {
        throw new Error(`Function "${id}" is in project ${current.outputs.project} and cannot move to ${wanted}`);
      }
      if (current.outputs.region && current.outputs.region !== region()) {
        throw new Error(`Function "${id}" is in ${current.outputs.region} and cannot move to ${region()}; destroy it and apply again`);
      }
      const name = current.outputs.name || nameOf(project, id);
      const live = await inspect(name);
      if (!live) throw new Error(`Function "${id}" no longer exists; remove its entry from .cloudgear/state.json to deploy it again`);
      if (live.state === "DEPLOYING" || live.state === "DELETING") throw new Error(`Function "${id}" is ${live.state}; run apply again once it has finished`);

      const mask: string[] = [];
      const patch: { buildConfig?: Record<string, unknown>; serviceConfig?: Record<string, unknown> } = {};
      if (changes.includes("code")) {
        mask.push("buildConfig.source");
        patch.buildConfig = { source: { storageSource: await upload(project, source) } };
      }
      const refreshed = changes.includes("dependencies") && Object.values(spec.env).some((value) => value.startsWith("@output:"));
      if (changes.includes("config") || refreshed) {
        mask.push("serviceConfig.availableMemory", "serviceConfig.timeoutSeconds", "serviceConfig.environmentVariables");
        patch.serviceConfig = serviceConfig(spec, context);
        const had = optionsOf(current.spec).max_instances;
        if (spec.options?.max_instances) mask.push("serviceConfig.maxInstanceCount");
        else if (had) throw new Error(`Function "${id}": max_instances cannot be removed once set; give it a value instead`);
        if (current.spec.runtime !== undefined && spec.runtime !== current.spec.runtime) {
          mask.push("buildConfig.runtime");
          patch.buildConfig = { ...patch.buildConfig, runtime: spec.runtime };
        }
      }
      let url = current.outputs.url ?? "";
      if (mask.length) {
        try {
          await waitFor(await fns.http.request("PATCH", `${FUNCTIONS}/${name}?updateMask=${mask.join(",")}`, { name, ...patch }), `updating ${id}`);
        } catch (err) {
          if (statusOf(err) === 404) throw new Error(`Function "${id}" no longer exists; remove its entry from .cloudgear/state.json to deploy it again`);
          throw err;
        }
        url = (await settled(name)).url || url;
      }
      if (changes.includes("auth")) await setPublic(name, live.service, spec.auth === "none");
      return { url };
    },

    async delete(current: StateEntry) {
      const id = current.physical_name;
      const project = current.outputs.project || (await projectFor(current.spec, id));
      await removeFunction(current.outputs.name || nameOf(project, id));
      if (current.outputs.service_account_created === "true" && current.outputs.service_account) await removeServiceAccount(project, current.outputs.service_account);
      deps.log(`deleted function ${id}`);
    },

    // Read only; the function is recorded without its spec, so the next plan updates it to match the config.
    async adopt(entry): Promise<Adopted | undefined> {
      const id = entry.physical_name;
      const project = await projectFor(entry.spec, id);
      const name = nameOf(project, id);
      const live = await inspect(name);
      if (!live) return undefined;
      if (live.state !== "ACTIVE") throw new Error(`Function ${name} is ${live.state}${live.messages ? `: ${live.messages}` : ""}`);
      return {
        outputs: { name, url: live.url, project, region: region(), service_account: live.email, service_account_created: "false" },
        spec: {},
        notes: [`its code and settings are replaced by the config, and its environment variables not in the config are removed; it keeps its service account ${live.email || "(default)"}`],
      };
    },
  };
}
