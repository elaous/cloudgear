import { DeleteCertificateCommand, DescribeCertificateCommand, RequestCertificateCommand } from "@aws-sdk/client-acm";
import type { DnsDriver } from "@cloudgear/dns";
import { PartialApplyError, type Driver } from "../apply";
import type { CertificateComparable } from "../plan";
import type { SendClient } from "./index";

export interface CertificateDeps {
  acm: SendClient;
  dns: () => DnsDriver;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

const RECORD_ATTEMPTS = 36;
const ISSUE_ATTEMPTS = 180;
const POLL_MS = 10_000;
const FAILED = new Set(["FAILED", "VALIDATION_TIMED_OUT", "REVOKED", "INACTIVE", "EXPIRED"]);

// ACM certificates for CloudFront live in us-east-1; the caller passes a client for that region.
export function certificateDriver(deps: CertificateDeps): Driver {
  const describe = async (arn: string) =>
    (await deps.acm.send(new DescribeCertificateCommand({ CertificateArn: arn }))).Certificate as
      | { Status?: string; DomainValidationOptions?: { ResourceRecord?: { Name: string; Value: string } }[] }
      | undefined;

  // Validates and waits until issued; safe to run again after a partial failure.
  async function validate(arn: string, outputs: Record<string, string>): Promise<Record<string, string>> {
    let record: { Name: string; Value: string } | undefined;
    for (let attempt = 0; attempt < RECORD_ATTEMPTS && !record; attempt++) {
      record = (await describe(arn))?.DomainValidationOptions?.[0]?.ResourceRecord;
      if (!record) await deps.sleep(POLL_MS / 2);
    }
    if (!record) throw new Error(`ACM did not provide a DNS validation record for ${arn}`);

    const name = record.Name.replace(/\.$/, "");
    outputs.validation_name = name;
    outputs.validation_value = record.Value;
    await deps.dns().upsert({ name, type: "CNAME", values: [record.Value], ttl: 300 });

    for (let attempt = 0; attempt < ISSUE_ATTEMPTS; attempt++) {
      const status = (await describe(arn))?.Status;
      if (status === "ISSUED") return outputs;
      if (status && FAILED.has(status)) throw new Error(`Certificate ${arn} ended as ${status}`);
      await deps.sleep(POLL_MS);
    }
    throw new Error(`Timed out waiting for certificate ${arn} to be issued; check the validation record ${name}`);
  }

  return {
    async create(entry) {
      const spec = entry.spec as unknown as CertificateComparable;
      const outputs: Record<string, string> = {};
      try {
        const requested = await deps.acm.send(new RequestCertificateCommand({ DomainName: spec.domain, ValidationMethod: "DNS" }));
        const arn: string = requested.CertificateArn;
        outputs.arn = arn;
        return await validate(arn, outputs);
      } catch (err) {
        throw outputs.arn ? new PartialApplyError(err, outputs) : err;
      }
    },

    async update(_entry, current) {
      // Only a previous run that stopped before the certificate was issued gets here with work to do.
      if (!current.outputs.arn) throw new Error("Certificate state has no ARN; destroy and apply again");
      return validate(current.outputs.arn, { ...current.outputs });
    },

    async delete(current) {
      if (current.outputs.validation_name) await deps.dns().remove(current.outputs.validation_name, "CNAME");
      if (!current.outputs.arn) return;
      // CloudFront releases the certificate a little after its distribution is gone.
      for (let attempt = 0; ; attempt++) {
        try {
          await deps.acm.send(new DeleteCertificateCommand({ CertificateArn: current.outputs.arn }));
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
