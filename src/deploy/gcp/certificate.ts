import { PartialApplyError, type Driver } from "../apply";
import type { CertificateComparable } from "../plan";
import { stateKey } from "../state";
import { CERTIFICATE_MANAGER, edgeId, sameTarget, statusOf, waitCertificateOperation, type EdgeDeps } from "./edge";
import { resolveProject, type GcpDeps } from "./index";

const ISSUE_ATTEMPTS = 180;
const ISSUE_WAIT_MS = 10_000;
const IN_USE_ATTEMPTS = 30;
const IN_USE_WAIT_MS = 20_000;

// A certificate for the domain covers its wildcard, and the authorization is for the parent domain.
const authorizedDomain = (domain: string) => domain.replace(/^\*\./, "");

export function certificateDriver(deps: GcpDeps, edge: EdgeDeps): Driver {
  const log = deps.log;
  const parent = (project: string) => `projects/${project}/locations/global`;

  // Each step is skipped when its output is already recorded, so a rerun resumes after a failure.
  async function converge(spec: CertificateComparable, outputs: Record<string, string>): Promise<Record<string, string>> {
    const project = outputs.project || (await resolveProject(deps, spec.project, `Certificate "${spec.domain}"`));
    outputs.project = project;
    const id = edgeId(spec.domain);
    const base = parent(project);
    try {
      if (!outputs.dns_authorization) {
        await waitCertificateOperation(edge, await edge.http.request("POST", `${CERTIFICATE_MANAGER}/${base}/dnsAuthorizations?dnsAuthorizationId=${id}`, { domain: authorizedDomain(spec.domain) }));
        outputs.dns_authorization = `${base}/dnsAuthorizations/${id}`;
        log(`created a DNS authorization for ${spec.domain}`);
      }
      if (!outputs.validation_name) {
        const authorization = await edge.http.request("GET", `${CERTIFICATE_MANAGER}/${outputs.dns_authorization}`);
        const record = authorization.dnsResourceRecord as { name: string; data: string } | undefined;
        if (!record) throw new Error(`Certificate Manager gave no DNS record for ${outputs.dns_authorization}`);
        const name = record.name.replace(/\.$/, "");
        const dns = await edge.dns(spec.dns_provider, spec.dns_zone, spec.dns_token);
        const existing = await dns.get(name, "CNAME");
        if (existing && !sameTarget(existing.values[0], record.data)) {
          throw new Error(`DNS record ${name} already exists with a different value (${existing.values[0]}); remove it so the certificate can be authorized`);
        }
        if (!existing) await dns.upsert({ name, type: "CNAME", values: [record.data], ttl: 300 });
        outputs.validation_name = name;
        outputs.validation_value = record.data;
        log(existing ? `authorization record ${name} is already in place` : `wrote authorization record ${name}`);
      }
      if (!outputs.certificate) {
        await waitCertificateOperation(
          edge,
          await edge.http.request("POST", `${CERTIFICATE_MANAGER}/${base}/certificates?certificateId=${id}`, {
            managed: { domains: [spec.domain], dnsAuthorizations: [outputs.dns_authorization] },
          }),
        );
        outputs.certificate = `${base}/certificates/${id}`;
        log(`requested a certificate for ${spec.domain}`);
      }
      log("waiting for the certificate to be issued");
      for (let attempt = 0; attempt < ISSUE_ATTEMPTS; attempt++) {
        const certificate = await edge.http.request("GET", `${CERTIFICATE_MANAGER}/${outputs.certificate}`);
        const state = certificate.managed?.state as string | undefined;
        if (state === "ACTIVE") {
          log("certificate issued");
          return outputs;
        }
        if (state === "FAILED") throw new Error(`Certificate ${outputs.certificate} failed: ${certificate.managed?.provisioningIssue?.details ?? certificate.managed?.provisioningIssue?.reason ?? "no reason given"}`);
        await edge.sleep(ISSUE_WAIT_MS);
      }
      throw new Error(`Timed out waiting for certificate ${outputs.certificate}; check the authorization record ${outputs.validation_name}`);
    } catch (err) {
      throw new PartialApplyError(err, outputs);
    }
  }

  return {
    async create(entry, context) {
      const spec = entry.spec as unknown as CertificateComparable;
      const taken = context.entry(stateKey({ type: "@gcp.CloudCdn", name: spec.domain }));
      if (spec.for_endpoint && !taken && !spec.domain.startsWith("*.")) {
        const dns = await edge.dns(spec.dns_provider, spec.dns_zone, spec.dns_token);
        for (const type of ["A", "CNAME"] as const) {
          const record = await dns.get(spec.domain, type);
          if (record) throw new Error(`DNS record ${spec.domain} already exists (${type} ${record.values[0]}); remove it or serve the site from another name`);
        }
      }
      return converge(spec, {});
    },

    async update(entry, current) {
      const spec = entry.spec as unknown as CertificateComparable;
      if (spec.project && current.outputs.project && spec.project !== current.outputs.project) {
        throw new Error(`Certificate ${entry.physical_name} is in project ${current.outputs.project} and cannot move to ${spec.project}`);
      }
      return converge(spec, { ...current.outputs });
    },

    async delete(current) {
      if (current.outputs.validation_name) log(`leaving the authorization record ${current.outputs.validation_name} in place`);
      const remove = async (name: string | undefined, inUseRetries: boolean) => {
        if (!name) return;
        for (let attempt = 0; ; attempt++) {
          try {
            await waitCertificateOperation(edge, await edge.http.request("DELETE", `${CERTIFICATE_MANAGER}/${name}`));
            return;
          } catch (err) {
            const status = statusOf(err);
            if (status === 404) return;
            if (!inUseRetries || (status !== 400 && status !== 409) || attempt >= IN_USE_ATTEMPTS) throw err;
            await edge.sleep(IN_USE_WAIT_MS);
          }
        }
      };
      // The load balancer lets go of the certificate after the CDN is gone.
      await remove(current.outputs.certificate, true);
      await remove(current.outputs.dns_authorization, true);
    },
  };
}
