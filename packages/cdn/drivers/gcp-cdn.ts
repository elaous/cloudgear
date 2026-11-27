import type { CdnDriver, CdnInfo } from "../cdn-driver";
import type { CertDriver, CertDriverOptions, CertInfo, CertState } from "../cert-driver";
import { edgeId } from "./gcp-names";

interface Requester {
  request(options: { url: string; method: string }): Promise<{ data: any }>;
  getProjectId(): Promise<string>;
}

async function defaultAuth(): Promise<Requester> {
  const { GoogleAuth } = await import("google-auth-library");
  return new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }) as unknown as Requester;
}

async function projectOf(auth: Requester): Promise<string> {
  return process.env.GOOGLE_CLOUD_PROJECT || (await auth.getProjectId());
}

async function getOrNull(auth: Requester, url: string): Promise<any | null> {
  try {
    return (await auth.request({ url, method: "GET" })).data;
  } catch (err) {
    const status = (err as { response?: { status?: number }; status?: number }).response?.status ?? (err as { status?: number }).status;
    if (status === 404) return null;
    throw err;
  }
}

export class GcpCdnDriver implements CdnDriver {
  constructor(private readonly auth?: Requester) {}

  async describe(domain: string): Promise<CdnInfo> {
    const auth = this.auth ?? (await defaultAuth());
    const project = await projectOf(auth);
    const rule = await getOrNull(auth, `https://compute.googleapis.com/compute/v1/projects/${project}/global/forwardingRules/${edgeId(domain, "-https-rule")}`);
    return rule ? { state: "deployed", id: rule.name, url: `https://${domain}` } : { state: "none" };
  }
}

const STATES: Record<string, CertState> = { ACTIVE: "issued", PROVISIONING: "pending", FAILED: "failed" };

export class GcpCertDriver implements CertDriver {
  constructor(private readonly auth?: Requester) {}

  async describe(domain: string): Promise<CertInfo> {
    const auth = this.auth ?? (await defaultAuth());
    const project = await projectOf(auth);
    const found = await getOrNull(auth, `https://certificatemanager.googleapis.com/v1/projects/${project}/locations/global/certificates/${edgeId(domain)}`);
    if (!found) return { state: "none" };
    return { state: STATES[found.managed?.state as string] ?? "pending", id: found.name };
  }
}

export function createGcpCdnDriver(): CdnDriver {
  return new GcpCdnDriver();
}

export function createGcpCertDriver(_options: CertDriverOptions): CertDriver {
  return new GcpCertDriver();
}
