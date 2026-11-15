import type { Adopted, Driver, Drivers } from "../apply";
import type { DesiredEntry } from "../plan";

export interface NeonDeps {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  log: (message: string) => void;
}

interface NeonProject {
  id: string;
  name: string;
  region_id: string;
  pg_version: number;
}

const BASE_URL = "https://console.neon.tech/api/v2";
const PAGE_SIZE = 100;

export function neonApiKey(env: Record<string, string | undefined> = process.env): string {
  const key = env.NEON_API_KEY?.trim();
  if (!key) throw new Error("Set NEON_API_KEY to deploy Neon databases (a personal API key from the Neon console); cloudgear does not store it");
  return key;
}

class NeonApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Responses can carry connection URIs with passwords; only the project fields are ever read.
function neonClient(deps: NeonDeps) {
  const send = deps.fetch ?? fetch;
  async function request(method: string, path: string, body?: unknown): Promise<any> {
    const res = await send(`${deps.baseUrl ?? BASE_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${deps.apiKey}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const detail = typeof parsed?.message === "string" ? parsed.message : res.statusText;
      throw new NeonApiError(res.status, `Neon API ${method} ${path.split("?")[0]} failed: ${res.status} ${detail}`);
    }
    return parsed;
  }

  return {
    async findByName(name: string): Promise<NeonProject | undefined> {
      const matches: NeonProject[] = [];
      let cursor: string | undefined;
      do {
        const page = await request("GET", `/projects?limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        const projects: NeonProject[] = page?.projects ?? [];
        matches.push(...projects.filter((p) => p.name === name));
        cursor = projects.length ? page?.pagination?.cursor : undefined;
      } while (cursor);
      if (matches.length > 1) throw new Error(`${matches.length} Neon projects are named "${name}"; rename or delete the extras so cloudgear knows which one to manage`);
      return matches[0];
    },
    async get(id: string): Promise<NeonProject | undefined> {
      try {
        return (await request("GET", `/projects/${encodeURIComponent(id)}`))?.project;
      } catch (err) {
        if (err instanceof NeonApiError && err.status === 404) return undefined;
        throw err;
      }
    },
    async create(name: string, region?: string, version?: string): Promise<NeonProject> {
      const created = await request("POST", "/projects", { project: { name, ...(region ? { region_id: region } : {}), ...(version ? { pg_version: Number(version) } : {}) } });
      return created.project;
    },
    async remove(id: string): Promise<void> {
      try {
        await request("DELETE", `/projects/${encodeURIComponent(id)}`);
      } catch (err) {
        if (!(err instanceof NeonApiError && err.status === 404)) throw err;
      }
    },
  };
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const wanted = (entry: Pick<DesiredEntry, "spec">) => {
  const options = (entry.spec.options ?? {}) as Record<string, string>;
  return { region: options.region, version: options.pg_version };
};

const outputsOf = (project: NeonProject): Record<string, string> => ({ project_id: project.id, region: project.region_id, pg_version: String(project.pg_version) });

// Mismatches Neon cannot fix in place.
function differences(project: NeonProject, want: { region?: string; version?: string }): string[] {
  const found: string[] = [];
  if (want.region && project.region_id !== want.region) found.push(`region is ${project.region_id}, not ${want.region}`);
  if (want.version && String(project.pg_version) !== want.version) found.push(`Postgres is ${project.pg_version}, not ${want.version}`);
  return found;
}

export function neonDrivers(deps: NeonDeps): Drivers {
  const neon = neonClient(deps);

  const database: Driver = {
    // Adopts a project that already has the name, so a second one is never created.
    async create(entry) {
      const want = wanted(entry);
      const existing = await neon.findByName(entry.physical_name);
      if (existing) {
        const problems = differences(existing, want);
        if (problems.length) throw new Error(`Neon project "${entry.physical_name}" already exists but its ${problems.join(" and ")}; Neon cannot change that in place`);
        deps.log(`adopted existing Neon project ${entry.physical_name}`);
        return outputsOf(existing);
      }
      const created = await neon.create(entry.physical_name, want.region, want.version);
      deps.log(`created Neon project ${entry.physical_name}`);
      return outputsOf(created);
    },
    async update(entry, current) {
      const live = (current.outputs.project_id ? await neon.get(current.outputs.project_id) : undefined) ?? (await neon.findByName(entry.physical_name));
      if (!live) throw new Error(`Neon project "${entry.physical_name}" no longer exists; remove it from the state or re-create it`);
      const problems = differences(live, wanted(entry));
      if (problems.length) throw new Error(`Neon project "${entry.physical_name}": ${problems.join(" and ")}; Neon cannot change that in place, so migrate the data by hand and use a new name`);
      return outputsOf(live);
    },
    async delete(current) {
      const options = (current.spec.options ?? {}) as Record<string, string>;
      if (options.allow_destroy !== "true") {
        throw new Error(`Refusing to delete Neon project "${current.physical_name}": it holds data. Declare it with allowDestroy: true, apply, then remove it`);
      }
      const id = current.outputs.project_id ?? (await neon.findByName(current.physical_name))?.id;
      if (id) await neon.remove(id);
      deps.log(`deleted Neon project ${current.physical_name}`);
    },
    async adopt(entry): Promise<Adopted | undefined> {
      const found = await neon.findByName(entry.physical_name);
      if (!found) return undefined;
      const problems = differences(found, wanted(entry));
      return problems.length
        ? { outputs: outputsOf(found), spec: { physical_name: entry.physical_name }, notes: [`Neon project "${entry.physical_name}": ${problems.join(" and ")}; apply cannot change that, so update setup.ts to match`] }
        : { outputs: outputsOf(found), spec: entry.spec };
    },
  };

  return { "@neon.Database": database };
}
