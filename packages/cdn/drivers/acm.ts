import { ACMClient, ListCertificatesCommand } from "@aws-sdk/client-acm";
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

// ACM lists only some statuses unless asked for all of them.
const ALL_STATUSES = ["PENDING_VALIDATION", "ISSUED", "INACTIVE", "EXPIRED", "VALIDATION_TIMED_OUT", "REVOKED", "FAILED"];
const RANK: Record<CertState, number> = { none: 0, failed: 1, pending: 2, issued: 3 };

export class AcmCertDriver implements CertDriver {
  constructor(private readonly client: ACMClient) {}

  // Prefers issued, then validating, then failed; newest first.
  async describe(domain: string): Promise<CertInfo> {
    let best: { arn: string; createdAt: number; state: CertState } | undefined;
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListCertificatesCommand({ NextToken: token, CertificateStatuses: ALL_STATUSES as never }));
      for (const summary of page.CertificateSummaryList ?? []) {
        if (summary.DomainName !== domain || !summary.CertificateArn) continue;
        const candidate = { arn: summary.CertificateArn, createdAt: summary.CreatedAt?.getTime() ?? 0, state: STATES[summary.Status ?? ""] ?? "pending" };
        if (!best || RANK[candidate.state] > RANK[best.state] || (RANK[candidate.state] === RANK[best.state] && candidate.createdAt > best.createdAt)) best = candidate;
      }
      token = page.NextToken;
    } while (token);
    return best ? { state: best.state, id: best.arn } : { state: "none" };
  }
}

export function createAcmDriver(options: CertDriverOptions): CertDriver {
  return new AcmCertDriver(new ACMClient({ region: options.region ?? ACM_REGION }));
}
