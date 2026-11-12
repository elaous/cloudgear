import { DeleteCertificateCommand, DescribeCertificateCommand, ListCertificatesCommand, RequestCertificateCommand } from "@aws-sdk/client-acm";
import type { DnsDriver } from "@cloudgear/dns";
import type { SecretRefSpec } from "../../config/schema";
import { PartialApplyError, type Driver } from "../apply";
import type { CertificateComparable } from "../plan";
import { stateKey } from "../state";
import type { SendClient } from "./index";
import { expectArn } from "./arn";
import { tagList, type Tagger } from "./tags";

export interface CertificateDeps {
  tags?: Tagger;
  acm: (region: string) => SendClient;
  region: string;
  dns: (provider: string, zone: string, token?: SecretRefSpec) => Promise<DnsDriver>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

const RECORD_ATTEMPTS = 36;
const ISSUE_ATTEMPTS = 180;
const POLL_MS = 10_000;
const FAILED = new Set(["FAILED", "VALIDATION_TIMED_OUT", "REVOKED", "INACTIVE", "EXPIRED"]);

export function sameTarget(a: string | undefined, b: string | undefined): boolean {
  const normalize = (value: string | undefined) => (value ?? "").trim().toLowerCase().replace(/\.$/, "");
  return normalize(a) === normalize(b);
}

const KEY_TYPES = ["RSA_1024", "RSA_2048", "RSA_3072", "RSA_4096", "EC_prime256v1", "EC_secp384r1", "EC_secp521r1"];

export function certificateDriver(deps: CertificateDeps): Driver {
  const regionOfArn = (arn: string) => arn.split(":")[3] || deps.region;
  const describe = async (arn: string) =>
    (await deps.acm(regionOfArn(arn)).send(new DescribeCertificateCommand({ CertificateArn: arn }))).Certificate as
      | { Status?: string; DomainName?: string; Type?: string; KeyAlgorithm?: string; NotAfter?: Date | string; DomainValidationOptions?: { ResourceRecord?: { Name: string; Value: string } }[] }
      | undefined;

  // Waits until issued; safe to rerun after partial failure.
  async function validate(arn: string, outputs: Record<string, string>, spec: CertificateComparable): Promise<Record<string, string>> {
    let record: { Name: string; Value: string } | undefined;
    deps.log("waiting for ACM's DNS validation record");
    for (let attempt = 0; attempt < RECORD_ATTEMPTS && !record; attempt++) {
      record = (await describe(arn))?.DomainValidationOptions?.[0]?.ResourceRecord;
      if (!record) await deps.sleep(POLL_MS / 2);
    }
    if (!record) throw new Error(`ACM did not provide a DNS validation record for ${arn}`);

    const name = record.Name.replace(/\.$/, "");
    outputs.validation_name = name;
    outputs.validation_value = record.Value;
    const dns = await deps.dns(spec.dns_provider, spec.dns_zone, spec.dns_token);
    // ACM shares one validation record per domain; reuse it.
    const existing = await dns.get(name, "CNAME");
    if (existing && !sameTarget(existing.values[0], record.Value)) {
      throw new Error(`DNS record ${name} already exists with a different value (${existing.values[0]}); remove it so the certificate can be validated`);
    }
    if (!existing) await dns.upsert({ name, type: "CNAME", values: [record.Value], ttl: 300 });
    deps.log(existing ? `validation record ${name} is already in place` : `wrote validation record ${name}`);

    deps.log("waiting for the certificate to be issued");
    for (let attempt = 0; attempt < ISSUE_ATTEMPTS; attempt++) {
      const status = (await describe(arn))?.Status;
      if (status === "ISSUED") {
        deps.log("certificate issued");
        return outputs;
      }
      if (status && FAILED.has(status)) throw new Error(`Certificate ${arn} ended as ${status}`);
      await deps.sleep(POLL_MS);
    }
    throw new Error(`Timed out waiting for certificate ${arn} to be issued; check the validation record ${name}`);
  }

  return {
    async adopt(entry, _context, hint) {
      const spec = entry.spec as unknown as CertificateComparable;
      type Summary = { DomainName?: string; CertificateArn?: string; Status?: string; Type?: string; KeyAlgorithm?: string; NotAfter?: Date | string };
      const matches: Summary[] = [];
      if (hint?.arn) {
        const arn = hint.arn;
        const parsed = expectArn(arn, "acm", "an ACM certificate");
        if (!parsed.resource.startsWith("certificate/")) throw new Error(`"${arn}" is not an ACM certificate ARN`);
        const wanted = spec.region || deps.region;
        if (parsed.region !== wanted) throw new Error(`${arn} is in ${parsed.region}, but this certificate must be in ${wanted}`);
        let described: Summary | undefined;
        try {
          described = (await describe(arn)) as Summary | undefined;
        } catch (err) {
          if ((err as { name?: string }).name === "ResourceNotFoundException") return undefined;
          throw err;
        }
        if (!described) return undefined;
        if (described.DomainName !== spec.domain) throw new Error(`${arn} is a certificate for ${described.DomainName}, not ${spec.domain}`);
        if (described.Status !== "ISSUED" && described.Status !== "PENDING_VALIDATION") throw new Error(`${arn} is ${described.Status}; only an issued certificate, or one waiting for validation, can be imported`);
        matches.push({ ...described, CertificateArn: arn });
      } else {
        const acm = deps.acm(spec.region || deps.region);
        let token: string | undefined;
        do {
          const page = await acm.send(new ListCertificatesCommand({ CertificateStatuses: ["ISSUED", "PENDING_VALIDATION"], Includes: { keyTypes: KEY_TYPES as never }, NextToken: token }));
          for (const summary of (page.CertificateSummaryList ?? []) as Summary[]) {
            if (summary.DomainName === spec.domain && summary.CertificateArn) matches.push(summary);
          }
          token = page.NextToken;
        } while (token);
      }
      const issued = matches.filter((m) => m.Status === "ISSUED").sort((a, b) => new Date(b.NotAfter ?? 0).getTime() - new Date(a.NotAfter ?? 0).getTime());
      const chosen = issued[0] ?? matches[0];
      if (!chosen?.CertificateArn) return undefined;
      const notes: string[] = [];
      if (matches.length > 1) notes.push(`${matches.length} certificates exist for ${spec.domain}; using ${chosen.CertificateArn}${issued.length ? ", the issued one that expires last" : ""}`);
      const external = chosen.Type !== undefined && chosen.Type !== "AMAZON_ISSUED";
      if (external) notes.push(`it is an ${chosen.Type} certificate, not one ACM validates by DNS; cloudgear will use it as it is`);
      const actual = chosen.KeyAlgorithm ?? "RSA_2048";
      const wanted = spec.options?.key_algorithm ?? "RSA_2048";
      return {
        outputs: { arn: chosen.CertificateArn, ...(external ? { validated: "externally" } : {}) },
        // An issued certificate that matches is recorded as the config describes it: nothing left to update.
        spec: actual === wanted && chosen.Status === "ISSUED" ? (entry.spec as Record<string, unknown>) : { options: { key_algorithm: actual } },
        notes,
      };
    },

    async create(entry, context) {
      const spec = entry.spec as unknown as CertificateComparable;
      const outputs: Record<string, string> = {};
      const taken = ["@aws.CloudFront", "@aws.ApiGateway"].some((type) => context.entry(stateKey({ type, name: spec.domain })));
      // Fail early if endpoint rejects the record; wildcards have none.
      if (spec.for_endpoint && !taken && !spec.domain.startsWith("*.")) {
        const record = await (await deps.dns(spec.dns_provider, spec.dns_zone, spec.dns_token)).get(spec.domain, "CNAME");
        if (record) {
          throw new Error(`DNS record ${spec.domain} already exists (CNAME ${record.values[0]}); remove it or serve the site from another name`);
        }
      }
      try {
        const requested = await deps.acm(spec.region || deps.region).send(new RequestCertificateCommand({ DomainName: spec.domain, ValidationMethod: "DNS", KeyAlgorithm: spec.options?.key_algorithm as never, ...(deps.tags ? { Tags: tagList(deps.tags(spec.domain)) } : {}) }));
        const arn: string = requested.CertificateArn;
        outputs.arn = arn;
        deps.log(`requested a certificate for ${spec.domain}`);
        return await validate(arn, outputs, spec);
      } catch (err) {
        throw outputs.arn ? new PartialApplyError(err, outputs) : err;
      }
    },

    async update(entry, current) {
      if (!current.outputs.arn) throw new Error("Certificate state has no ARN; destroy and apply again");
      const wanted = (entry.spec as unknown as CertificateComparable).region || deps.region;
      if (regionOfArn(current.outputs.arn) !== wanted) {
        throw new Error(`Certificate ${entry.physical_name} cannot move from ${regionOfArn(current.outputs.arn)} to ${wanted}; destroy it and apply again`);
      }
      const algorithm = (spec: Record<string, unknown>) => (spec.options as Record<string, string> | undefined)?.key_algorithm ?? "RSA_2048";
      if (algorithm(current.spec) !== algorithm(entry.spec)) {
        throw new Error(`Certificate ${entry.physical_name} cannot change key_algorithm; destroy it and apply again`);
      }
      // Imported certificates have no validation record to wait for.
      if (current.outputs.validated === "externally") return { ...current.outputs };
      // An issued certificate is done: nothing to validate, no DNS to touch.
      if ((await describe(current.outputs.arn))?.Status === "ISSUED") {
        deps.log(`certificate ${entry.physical_name} is issued; nothing to do`);
        return { ...current.outputs };
      }
      try {
        return await validate(current.outputs.arn, { ...current.outputs }, entry.spec as unknown as CertificateComparable);
      } catch (err) {
        throw new PartialApplyError(err, current.outputs);
      }
    },

    async delete(current) {
      // Validation record stays; ACM shares it per domain.
      if (current.outputs.validation_name) deps.log(`leaving the validation record ${current.outputs.validation_name} in place`);
      if (!current.outputs.arn) return;
      // CloudFront releases the certificate after its distribution is gone.
      for (let attempt = 0; ; attempt++) {
        try {
          await deps.acm(regionOfArn(current.outputs.arn)).send(new DeleteCertificateCommand({ CertificateArn: current.outputs.arn }));
          return;
        } catch (err) {
          const name = (err as { name?: string }).name;
          if (name === "ResourceNotFoundException") return;
          if (name !== "ResourceInUseException" || attempt >= 30) throw err;
          await deps.sleep(20_000);
        }
      }
    },
  };
}
