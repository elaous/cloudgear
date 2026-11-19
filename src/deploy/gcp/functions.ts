import { zip } from "../../build/zip";
import type { FunctionSpec } from "../../config/schema";
import { environmentOptions } from "../../providers";
import type { Adopted, Driver, DriverContext } from "../apply";
import { resolveOutputReferences } from "../environment";
import type { DesiredEntry, FunctionComparable } from "../plan";
import type { StateEntry } from "../state";
import { fitName } from "../../names";
import { GcpApiError, type GcpHttp } from "./http";
import { labelsFrom, resolveProject, type GcpDeps } from "./index";

export interface FunctionDeps {
  http: GcpHttp;
  region?: string;
  readBundle: (fn: FunctionSpec) => Uint8Array;
  readIncluded?: (fn: FunctionSpec) => { name: string; data: Uint8Array }[];
  sleep: (ms: number) => Promise<void>;
}

const FUNCTIONS = "https://cloudfunctions.googleapis.com/v2";
const IAM = "https://iam.googleapis.com/v1";
const INVOKER = "roles/cloudfunctions.invoker";
const OPERATION_ATTEMPTS = 120;
const OPERATION_WAIT_MS = 5000;
const PROPAGATION_ATTEMPTS = 10;
const PROPAGATION_WAIT_MS = 4000;

const optionsOf = (spec: Record<string, unknown>): Record<string, string> => (spec.options ?? {}) as Record<string, string>;

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

  async function waitFor(operation: { name?: string; done?: boolean; error?: { message?: string } }, what: string): Promise<void> {
    let current = operation;
    for (let attempt = 0; attempt < OPERATION_ATTEMPTS; attempt++) {
      if (current.done) {
        if (current.error) throw new Error(`${what} failed: ${current.error.message ?? "unknown error"}`);
        return;
      }
      await fns.sleep(OPERATION_WAIT_MS);
      current = await fns.http.request("GET", `${FUNCTIONS}/${operation.name}`);
    }
    throw new Error(`${what} is still running after ${(OPERATION_ATTEMPTS * OPERATION_WAIT_MS) / 60000} minutes; run apply again`);
  }

  // A new service account takes a few seconds to be usable.
  async function retried<T>(run: () => Promise<T>, email: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (err) {
        const status = (err as GcpApiError).status;
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
      availableMemory: `${spec.memory_mb}M`,
      timeoutSeconds: spec.timeout_s,
      environmentVariables: { ...resolveOutputReferences(spec.env, context), ...environmentOptions(spec.options) },
      ...(options.max_instances ? { maxInstanceCount: Number(options.max_instances) } : {}),
      ...(email ? { serviceAccountEmail: email, ingressSettings: "ALLOW_ALL", allTrafficOnLatestRevision: true } : {}),
    };
  }

  async function setPublic(name: string, open: boolean): Promise<void> {
    const policy = (await fns.http.request("GET", `${FUNCTIONS}/${name}:getIamPolicy`)) as { bindings?: { role: string; members?: string[] }[] };
    const bindings = (policy.bindings ?? []).map((b) => ({ ...b, members: [...(b.members ?? [])] }));
    const existing = bindings.find((b) => b.role === INVOKER);
    const has = existing?.members.includes("allUsers") ?? false;
    if (open === has) return;
    if (open) {
      if (existing) existing.members.push("allUsers");
      else bindings.push({ role: INVOKER, members: ["allUsers"] });
    } else if (existing) {
      existing.members = existing.members.filter((m) => m !== "allUsers");
    }
    await fns.http.request("POST", `${FUNCTIONS}/${name}:setIamPolicy`, { policy: { ...policy, bindings: bindings.filter((b) => b.members.length) } });
  }

  async function ensureServiceAccount(project: string, id: string, label: string): Promise<{ email: string; created: boolean }> {
    const accountId = serviceAccountIdFor(id);
    const email = `${accountId}@${project}.iam.gserviceaccount.com`;
    try {
      await fns.http.request("POST", `${IAM}/projects/${project}/serviceAccounts`, { accountId, serviceAccount: { displayName: `cloudgear: ${label}`.slice(0, 100) } });
      return { email, created: true };
    } catch (err) {
      if ((err as GcpApiError).status === 409) return { email, created: false };
      throw err;
    }
  }

  async function removeServiceAccount(project: string, email: string): Promise<void> {
    try {
      await fns.http.request("DELETE", `${IAM}/projects/${project}/serviceAccounts/${email}`);
    } catch (err) {
      if ((err as GcpApiError).status !== 404) throw err;
    }
  }

  async function removeFunction(name: string): Promise<void> {
    try {
      await waitFor(await fns.http.request("DELETE", `${FUNCTIONS}/${name}`), `deleting ${name}`);
    } catch (err) {
      if ((err as GcpApiError).status !== 404) throw err;
    }
  }

  async function activeFunction(name: string): Promise<{ url: string; email: string }> {
    const found = await fns.http.request("GET", `${FUNCTIONS}/${name}`);
    if (found.state && found.state !== "ACTIVE") {
      const reason = (found.stateMessages ?? []).map((m: { message?: string }) => m.message).filter(Boolean).join("; ");
      throw new Error(`Function ${name} is ${found.state}${reason ? `: ${reason}` : ""}`);
    }
    return { url: found.url ?? found.serviceConfig?.uri ?? "", email: found.serviceConfig?.serviceAccountEmail ?? "" };
  }

  return {
    async create(entry: DesiredEntry, context) {
      const spec = entry.spec as unknown as FunctionComparable;
      const source = entry.source as FunctionSpec;
      const id = entry.physical_name;
      const project = await projectFor(entry.spec, id);
      const name = nameOf(project, id);
      const account = await ensureServiceAccount(project, id, entry.name);
      let functionCreated = false;
      try {
        const storageSource = await upload(project, source);
        const body = {
          environment: "GEN_2",
          labels: labelsFrom(deps.labels, entry.name),
          buildConfig: { runtime: spec.runtime, entryPoint: "handler", source: { storageSource } },
          serviceConfig: serviceConfig(spec, context, account.email),
        };
        const operation = await retried(() => fns.http.request("POST", `${FUNCTIONS}/projects/${project}/locations/${region()}/functions?functionId=${id}`, body), account.email);
        functionCreated = true;
        await waitFor(operation, `deploying ${id}`);
        const live = await activeFunction(name);
        if (spec.auth === "none") await setPublic(name, true);
        deps.log(`deployed function ${id}`);
        return { name, url: live.url, project, region: region(), service_account: account.email, service_account_created: String(account.created) };
      } catch (err) {
        // Leave nothing half made; the next apply starts clean.
        if (functionCreated) await removeFunction(name).catch(() => undefined);
        if (account.created) await removeServiceAccount(project, account.email).catch(() => undefined);
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
      const mask: string[] = [];
      const patch: Record<string, unknown> = {};
      if (changes.includes("code")) {
        mask.push("buildConfig.source");
        patch.buildConfig = { source: { storageSource: await upload(project, source) } };
      }
      const refreshed = changes.includes("dependencies") && Object.values(spec.env).some((value) => value.startsWith("@output:"));
      if (changes.includes("config") || refreshed) {
        mask.push("serviceConfig.availableMemory", "serviceConfig.timeoutSeconds", "serviceConfig.environmentVariables");
        const config = serviceConfig(spec, context);
        if (spec.options?.max_instances) mask.push("serviceConfig.maxInstanceCount");
        patch.serviceConfig = config;
      }
      let url = current.outputs.url ?? "";
      if (mask.length) {
        const operation = await fns.http.request("PATCH", `${FUNCTIONS}/${name}?updateMask=${mask.join(",")}`, { name, ...patch });
        await waitFor(operation, `updating ${id}`);
        url = (await activeFunction(name)).url || url;
      }
      if (changes.includes("auth")) await setPublic(name, spec.auth === "none");
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
      try {
        const live = await activeFunction(name);
        return {
          outputs: { name, url: live.url, project, region: region(), service_account: live.email, service_account_created: "false" },
          spec: {},
          notes: [`its code and settings are replaced by the config, and its environment variables not in the config are removed; it keeps its service account ${live.email || "(default)"}`],
        };
      } catch (err) {
        if ((err as GcpApiError).status === 404) return undefined;
        throw err;
      }
    },
  };
}
