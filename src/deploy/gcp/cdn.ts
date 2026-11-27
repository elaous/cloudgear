import { PartialApplyError, type Driver, type DriverContext } from "../apply";
import type { CdnComparable } from "../plan";
import { stateKey } from "../state";
import { changeGrant } from "./grants";
import { CERTIFICATE_MANAGER, COMPUTE, edgeId, sameTarget, statusOf, waitCertificateOperation, waitComputeOperation, type EdgeDeps } from "./edge";
import { resolveProject, type GcpDeps } from "./index";

const PUBLIC_ROLE = "roles/storage.legacyObjectReader";
const ALL_USERS = "allUsers";
const IN_USE_ATTEMPTS = 12;
const IN_USE_WAIT_MS = 10_000;
const DNS_TTL = 300;

const PUBLIC_REFUSED = (bucket: string) =>
  `GCS refused to make bucket "${bucket}" public. An organization policy can forbid it: check constraints/storage.publicAccessPrevention and iam.allowedPolicyMemberDomains (domain-restricted sharing)`;

// Clears a URL map's cache for the host; the path pattern may end in "*".
export async function invalidateGcpCdn(edge: Pick<EdgeDeps, "http" | "sleep">, project: string, urlMap: string, host: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    await waitComputeOperation(edge, project, await edge.http.request("POST", `${COMPUTE}/projects/${project}/global/urlMaps/${urlMap}/invalidateCache`, { host, path }));
  }
}

export function cdnDriver(deps: GcpDeps, edge: EdgeDeps): Driver {
  const log = deps.log;

  const names = (domain: string) => ({
    address: edgeId(domain, "-ip"),
    backendBucket: edgeId(domain, "-bucket"),
    urlMap: edgeId(domain, "-map"),
    httpsProxy: edgeId(domain, "-https"),
    httpsRule: edgeId(domain, "-https-rule"),
    redirectMap: edgeId(domain, "-redirect"),
    httpProxy: edgeId(domain, "-http"),
    httpRule: edgeId(domain, "-http-rule"),
    certificateMap: edgeId(domain, "-certs"),
    certificateEntry: edgeId(domain, "-entry"),
  });

  const compute = (project: string, collection: string, name?: string) => `${COMPUTE}/projects/${project}/global/${collection}${name ? `/${name}` : ""}`;

  // Creates a global Compute resource; one that already exists under our name is taken as ours.
  async function insert(project: string, collection: string, body: { name: string } & Record<string, unknown>): Promise<void> {
    try {
      await waitComputeOperation(edge, project, await edge.http.request("POST", compute(project, collection), body));
    } catch (err) {
      if (statusOf(err) !== 409) throw err;
    }
  }

  async function remove(project: string, collection: string, name: string | undefined): Promise<void> {
    if (!name) return;
    for (let attempt = 0; ; attempt++) {
      try {
        await waitComputeOperation(edge, project, await edge.http.request("DELETE", compute(project, collection, name)));
        return;
      } catch (err) {
        const status = statusOf(err);
        if (status === 404) return;
        if ((status !== 400 && status !== 409) || attempt >= IN_USE_ATTEMPTS) throw err;
        await edge.sleep(IN_USE_WAIT_MS);
      }
    }
  }

  async function removeMapEntry(project: string, map: string, entry: string): Promise<void> {
    try {
      await waitCertificateOperation(edge, await edge.http.request("DELETE", `${CERTIFICATE_MANAGER}/projects/${project}/locations/global/certificateMaps/${map}/certificateMapEntries/${entry}`));
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
  }

  async function createCertificateMap(project: string, domain: string, certificate: string, outputs: Record<string, string>): Promise<void> {
    const n = names(domain);
    const base = `${CERTIFICATE_MANAGER}/projects/${project}/locations/global`;
    if (!outputs.certificate_map) {
      try {
        await waitCertificateOperation(edge, await edge.http.request("POST", `${base}/certificateMaps?certificateMapId=${n.certificateMap}`, {}));
      } catch (err) {
        if (statusOf(err) !== 409) throw err;
      }
      outputs.certificate_map = n.certificateMap;
    }
    if (outputs.map_certificate && outputs.map_certificate !== certificate) {
      await removeMapEntry(project, n.certificateMap, n.certificateEntry);
      delete outputs.map_certificate;
    }
    if (!outputs.map_certificate) {
      try {
        await waitCertificateOperation(edge, await edge.http.request("POST", `${base}/certificateMaps/${n.certificateMap}/certificateMapEntries?certificateMapEntryId=${n.certificateEntry}`, { hostname: domain, certificates: [certificate] }));
      } catch (err) {
        if (statusOf(err) !== 409) throw err;
      }
      outputs.map_certificate = certificate;
    }
  }

  async function makePublic(project: string, bucket: string, outputs: Record<string, string>): Promise<void> {
    if (outputs.public_bucket === bucket) return;
    if (outputs.public_bucket && outputs.public_binding === "added") {
      await changeGrant(deps.storage(project), { bucket: outputs.public_bucket, role: PUBLIC_ROLE, path: "" }, ALL_USERS, false);
    }
    delete outputs.public_binding;
    delete outputs.public_bucket;
    try {
      const added = await changeGrant(deps.storage(project), { bucket, role: PUBLIC_ROLE, path: "" }, ALL_USERS, true);
      outputs.public_binding = added ? "added" : "existing";
      outputs.public_bucket = bucket;
      log(added ? `made bucket ${bucket} readable by everyone` : `bucket ${bucket} was already readable by everyone`);
    } catch (err) {
      const status = statusOf(err);
      if (status === 400 || status === 403 || status === 412) throw new Error(`${PUBLIC_REFUSED(bucket)}: ${(err as Error).message}`);
      throw err;
    }
  }

  async function converge(spec: CdnComparable, outputs: Record<string, string>, context: DriverContext): Promise<Record<string, string>> {
    const project = outputs.project || (await resolveProject(deps, spec.project, `CDN "${spec.domain}"`));
    outputs.project = project;
    const n = names(spec.domain);
    const certificateName = context.entry(stateKey({ type: "@gcp.Certificate", name: spec.certificate_domain ?? spec.domain }))?.outputs.certificate;
    if (!certificateName) throw new Error(`The certificate for "${spec.certificate_domain ?? spec.domain}" has no Certificate Manager certificate yet; apply it first`);
    try {
      if (!outputs.address) {
        await insert(project, "addresses", { name: n.address, ipVersion: "IPV4", addressType: "EXTERNAL" });
        const address = await edge.http.request("GET", compute(project, "addresses", n.address));
        if (!address?.address) throw new Error(`Compute gave no IP address for ${n.address}`);
        outputs.address = address.address as string;
        outputs.address_name = n.address;
        log(`reserved the address ${outputs.address}`);
      }
      if (!outputs.backend_bucket) {
        await insert(project, "backendBuckets", { name: n.backendBucket, bucketName: spec.bucket, enableCdn: true, cdnPolicy: { cacheMode: "CACHE_ALL_STATIC" } });
        outputs.backend_bucket = n.backendBucket;
        outputs.bucket = spec.bucket;
        log(`created the backend bucket for ${spec.bucket}`);
      } else if (outputs.bucket !== spec.bucket) {
        await waitComputeOperation(edge, project, await edge.http.request("PATCH", compute(project, "backendBuckets", n.backendBucket), { bucketName: spec.bucket }));
        outputs.bucket = spec.bucket;
        log(`pointed the backend bucket at ${spec.bucket}`);
      }
      await makePublic(project, spec.bucket, outputs);
      await createCertificateMap(project, spec.domain, certificateName, outputs);
      const mapUrl = compute(project, "urlMaps", n.urlMap);
      if (!outputs.url_map) {
        await insert(project, "urlMaps", { name: n.urlMap, defaultService: compute(project, "backendBuckets", n.backendBucket) });
        outputs.url_map = n.urlMap;
      }
      if (!outputs.https_proxy) {
        await insert(project, "targetHttpsProxies", { name: n.httpsProxy, urlMap: mapUrl, certificateMap: `//certificatemanager.googleapis.com/projects/${project}/locations/global/certificateMaps/${n.certificateMap}` });
        outputs.https_proxy = n.httpsProxy;
      }
      if (!outputs.https_rule) {
        await insert(project, "forwardingRules", { name: n.httpsRule, IPAddress: outputs.address, IPProtocol: "TCP", portRange: "443", target: compute(project, "targetHttpsProxies", n.httpsProxy), loadBalancingScheme: "EXTERNAL_MANAGED" });
        outputs.https_rule = n.httpsRule;
        log("created the HTTPS forwarding rule");
      }
      if (!outputs.redirect_map) {
        await insert(project, "urlMaps", { name: n.redirectMap, defaultUrlRedirect: { httpsRedirect: true, redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT", stripQuery: false } });
        outputs.redirect_map = n.redirectMap;
      }
      if (!outputs.http_proxy) {
        await insert(project, "targetHttpProxies", { name: n.httpProxy, urlMap: compute(project, "urlMaps", n.redirectMap) });
        outputs.http_proxy = n.httpProxy;
      }
      if (!outputs.http_rule) {
        await insert(project, "forwardingRules", { name: n.httpRule, IPAddress: outputs.address, IPProtocol: "TCP", portRange: "80", target: compute(project, "targetHttpProxies", n.httpProxy), loadBalancingScheme: "EXTERNAL_MANAGED" });
        outputs.http_rule = n.httpRule;
        log("created the HTTP to HTTPS redirect");
      }
      if (!outputs.a_record) {
        const dns = await edge.dns(spec.dns_provider, spec.dns_zone, spec.dns_token);
        const taken = await dns.get(spec.domain, "CNAME");
        if (taken) throw new Error(`DNS record ${spec.domain} already exists (CNAME ${taken.values[0]}); remove it so the CDN can use the name`);
        const existing = await dns.get(spec.domain, "A");
        if (existing && !sameTarget(existing.values[0], outputs.address)) {
          throw new Error(`DNS record ${spec.domain} already exists (A ${existing.values[0]}); remove it so the CDN can use the name`);
        }
        if (!existing) await dns.upsert({ name: spec.domain, type: "A", values: [outputs.address], ttl: DNS_TTL });
        outputs.a_record = spec.domain;
        log(`pointed ${spec.domain} at ${outputs.address}`);
      }
      outputs.url = `https://${spec.domain}`;
      return outputs;
    } catch (err) {
      throw Object.keys(outputs).length > 1 ? new PartialApplyError(err, outputs) : err;
    }
  }

  return {
    create: (entry, context) => converge(entry.spec as unknown as CdnComparable, {}, context),

    async update(entry, current, _changes, context) {
      const spec = entry.spec as unknown as CdnComparable;
      if (spec.project && current.outputs.project && spec.project !== current.outputs.project) {
        throw new Error(`CDN ${entry.physical_name} is in project ${current.outputs.project} and cannot move to ${spec.project}`);
      }
      return converge(spec, { ...current.outputs }, context);
    },

    async delete(current) {
      const o = current.outputs;
      const project = o.project || (await resolveProject(deps, (current.spec as unknown as CdnComparable).project, `CDN "${current.physical_name}"`));
      const spec = current.spec as unknown as CdnComparable;
      const n = names(spec.domain);
      if (o.a_record) {
        const dns = await edge.dns(spec.dns_provider, spec.dns_zone, spec.dns_token);
        const record = await dns.get(spec.domain, "A");
        if (record && sameTarget(record.values[0], o.address)) await dns.remove(spec.domain, "A");
        else if (record) log(`leaving the A record ${spec.domain}: it no longer points at ${o.address}`);
      }
      await remove(project, "forwardingRules", o.http_rule && n.httpRule);
      await remove(project, "forwardingRules", o.https_rule && n.httpsRule);
      await remove(project, "targetHttpProxies", o.http_proxy && n.httpProxy);
      await remove(project, "targetHttpsProxies", o.https_proxy && n.httpsProxy);
      await remove(project, "urlMaps", o.redirect_map && n.redirectMap);
      await remove(project, "urlMaps", o.url_map && n.urlMap);
      if (o.certificate_map) {
        await removeMapEntry(project, n.certificateMap, n.certificateEntry);
        try {
          await waitCertificateOperation(edge, await edge.http.request("DELETE", `${CERTIFICATE_MANAGER}/projects/${project}/locations/global/certificateMaps/${n.certificateMap}`));
        } catch (err) {
          if (statusOf(err) !== 404) throw err;
        }
      }
      await remove(project, "backendBuckets", o.backend_bucket && n.backendBucket);
      await remove(project, "addresses", o.address_name && n.address);
      if (o.public_binding === "added" && o.public_bucket) {
        await changeGrant(deps.storage(project), { bucket: o.public_bucket, role: PUBLIC_ROLE, path: "" }, ALL_USERS, false);
        log(`removed public read from bucket ${o.public_bucket}`);
      }
    },
  };
}
