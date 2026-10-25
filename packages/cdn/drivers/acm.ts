import { ACMClient, DescribeCertificateCommand, ListCertificatesCommand } from "@aws-sdk/client-acm";
import type { CertDriver, CertDriverOptions, CertInfo, CertState } from "../cert-driver";

// CloudFront only accepts certificates from us-east-1.
export const ACM_REGION = "us-east-1";

const STATES: Record<string, CertState> = {
  ISSUED: "issued",
  PENDING_VALIDATION: "pending",
  FAILED: "failed",
  VALIDATION_TIMED_OUT: "failed",
  REVOKED: "failed",
  INACTIVE: "failed",
  EXPIRED: "failed",
};

export class AcmCertDriver implements CertDriver {
  constructor(private readonly client: ACMClient) {}

  async describe(domain: string): Promise<CertInfo> {
    let best: { arn: string; createdAt: number; status?: string } | undefined;
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListCertificatesCommand({ NextToken: token }));
      for (const summary of page.CertificateSummaryList ?? []) {
        if (summary.DomainName !== domain || !summary.CertificateArn) continue;
        const createdAt = summary.CreatedAt?.getTime() ?? 0;
        if (!best || createdAt > best.createdAt) best = { arn: summary.CertificateArn, createdAt };
      }
      token = page.NextToken;
    } while (token);
    if (!best) return { state: "none" };
    const described = await this.client.send(new DescribeCertificateCommand({ CertificateArn: best.arn }));
    return { state: STATES[described.Certificate?.Status ?? ""] ?? "pending", id: best.arn };
  }
}

export function createAcmDriver(options: CertDriverOptions): CertDriver {
  return new AcmCertDriver(new ACMClient({ region: options.region ?? ACM_REGION }));
}
