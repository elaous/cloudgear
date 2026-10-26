import { DeleteCertificateCommand, DescribeCertificateCommand, RequestCertificateCommand } from "@aws-sdk/client-acm";
import type { DnsDriver } from "@cloudgear/dns";
import { PartialApplyError, type Driver } from "../apply";
import type { CertificateComparable } from "../plan";
import { stateKey } from "../state";
import type { SendClient } from "./index";

export interface CertificateDeps {
  acm: (region: string) => SendClient;
  region: string;
  dns: (provider: string, zone: string) => Promise<DnsDriver>;
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

export function certificateDriver(deps: CertificateDeps): Driver {
  const regionOfArn = (arn: string) => arn.split(":")[3] || deps.region;
  const describe = async (arn: string) =>
    (await deps.acm(regionOfArn(arn)).send(new DescribeCertificateCommand({ CertificateArn: arn }))).Certificate as
      | { Status?: string; DomainValidationOptions?: { ResourceRecord?: { Name: string; Value: string } }[] }
      | undefined;

  // Validates and waits until issued; safe to run again after a partial failure.
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
    const dns = await deps.dns(spec.dns_provider, spec.dns_zone);
    // ACM reuses one validation record per account and domain, so an identical one is already ours to use.
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
    async create(entry, context) {
      const spec = entry.spec as unknown as CertificateComparable;
      const outputs: Record<string, string> = {};
      const taken = ["@aws.CloudFront", "@aws.ApiGateway"].some((type) => context.entry(stateKey({ type, name: spec.domain })));
      // Fail early if the endpoint could not take the record later.
      if (spec.for_endpoint && !taken) {
        const record = await (await deps.dns(spec.dns_provider, spec.dns_zone)).get(spec.domain, "CNAME");
        if (record) {
          throw new Error(`DNS record ${spec.domain} already exists (CNAME ${record.values[0]}); remove it or serve the site from another name`);
        }
      }
      try {
        const requested = await deps.acm(spec.region || deps.region).send(new RequestCertificateCommand({ DomainName: spec.domain, ValidationMethod: "DNS", KeyAlgorithm: spec.options?.key_algorithm as never }));
        const arn: string = requested.CertificateArn;
        outputs.arn = arn;
        deps.log(`requested a certificate for ${spec.domain}`);
        return await validate(arn, outputs, spec);
      } catch (err) {
        throw outputs.arn ? new PartialApplyError(err, outputs) : err;
      }
    },

    async update(entry, current) {
      // Only a previous run that stopped before the certificate was issued gets here with work to do.
      if (!current.outputs.arn) throw new Error("Certificate state has no ARN; destroy and apply again");
      const wanted = (entry.spec as unknown as CertificateComparable).region || deps.region;
      if (regionOfArn(current.outputs.arn) !== wanted) {
        throw new Error(`Certificate ${entry.physical_name} cannot move from ${regionOfArn(current.outputs.arn)} to ${wanted}; destroy it and apply again`);
      }
      const algorithm = (spec: Record<string, unknown>) => (spec.options as Record<string, string> | undefined)?.key_algorithm ?? "RSA_2048";
      if (algorithm(current.spec) !== algorithm(entry.spec)) {
        throw new Error(`Certificate ${entry.physical_name} cannot change key_algorithm; destroy it and apply again`);
      }
      try {
        return await validate(current.outputs.arn, { ...current.outputs }, entry.spec as unknown as CertificateComparable);
      } catch (err) {
        throw new PartialApplyError(err, current.outputs);
      }
    },

    async delete(current) {
      // The validation record stays: ACM shares it between certificates for the same domain, and an unused one is harmless.
      if (current.outputs.validation_name) deps.log(`leaving the validation record ${current.outputs.validation_name} in place`);
      if (!current.outputs.arn) return;
      // CloudFront releases the certificate a little after its distribution is gone.
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
