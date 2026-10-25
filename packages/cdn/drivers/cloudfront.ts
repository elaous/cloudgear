import { CloudFrontClient, ListDistributionsCommand } from "@aws-sdk/client-cloudfront";
import type { CdnDriver, CdnInfo } from "../cdn-driver";

export class CloudFrontCdnDriver implements CdnDriver {
  constructor(private readonly client: CloudFrontClient) {}

  async describe(domain: string): Promise<CdnInfo> {
    let marker: string | undefined;
    do {
      const page = await this.client.send(new ListDistributionsCommand({ Marker: marker }));
      for (const item of page.DistributionList?.Items ?? []) {
        if (!item.Aliases?.Items?.includes(domain)) continue;
        return { state: item.Status === "Deployed" ? "deployed" : "deploying", id: item.Id, url: `https://${item.DomainName}` };
      }
      marker = page.DistributionList?.IsTruncated ? page.DistributionList.NextMarker : undefined;
    } while (marker);
    return { state: "none" };
  }
}

// CloudFront is a global service reached through us-east-1.
export function createCloudFrontDriver(): CdnDriver {
  return new CloudFrontCdnDriver(new CloudFrontClient({ region: "us-east-1" }));
}
