import { createHash } from "node:crypto";
import {
  CreateDistributionCommand,
  CreateInvalidationCommand,
  CreateOriginAccessControlCommand,
  type DistributionConfig,
  DeleteDistributionCommand,
  DeleteOriginAccessControlCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  GetOriginAccessControlCommand,
  ListOriginAccessControlsCommand,
  UpdateDistributionCommand,
} from "@aws-sdk/client-cloudfront";
import { AddPermissionCommand, RemovePermissionCommand } from "@aws-sdk/client-lambda";
import { DeleteBucketPolicyCommand, GetBucketPolicyCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3";
import type { DnsDriver } from "@cloudgear/dns";
import { fitName } from "../../names";
import { sameTarget } from "./certificate";
import { PartialApplyError, type Driver, type DriverContext } from "../apply";
import type { CdnComparable } from "../plan";
import { stateKey, type StateEntry } from "../state";
import type { SendClient } from "./index";

export interface CloudFrontDeps {
  cloudfront: SendClient;
  s3: (region?: string) => SendClient;
  lambda: SendClient;
  dns: (provider: string, zone: string) => Promise<DnsDriver>;
  region: string;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

// Managed cache and origin request policies.
const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

const DEPLOY_ATTEMPTS = 180;
const POLL_MS = 10_000;
const CLOUDFRONT = "cloudfront.amazonaws.com";
const ALL_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"];

interface FunctionOrigin {
  physical: string;
  host: string;
  arn: string;
}

export function cloudFrontDriver(deps: CloudFrontDeps): Driver {
  const tag = (domain: string) => createHash("sha256").update(domain).digest("hex").slice(0, 12);

  function functionOrigins(entry: { deps: string[] }, spec: CdnComparable, context: DriverContext): Map<string, FunctionOrigin> {
    const origins = new Map<string, FunctionOrigin>();
    for (const behavior of spec.behaviors) {
      if (origins.has(behavior.function)) continue;
      const fn = entry.deps
        .map((key) => context.entry(key))
        .find((e) => e?.type === "@aws.Lambda" && e.physical_name === behavior.function);
      if (!fn?.outputs.url || !fn.outputs.arn) throw new Error(`Function "${behavior.function}" has no URL yet; apply it first`);
      origins.set(behavior.function, { physical: behavior.function, host: new URL(fn.outputs.url).host, arn: fn.outputs.arn });
    }
    return origins;
  }

  async function ensureOac(label: string, type: "s3" | "lambda", known?: string): Promise<string> {
    if (known) return known;
    const name = fitName(label, 64);
    try {
      const created = await deps.cloudfront.send(
        new CreateOriginAccessControlCommand({
          OriginAccessControlConfig: {
            Name: name,
            Description: "Managed by cloudgear",
            SigningProtocol: "sigv4",
            SigningBehavior: "always",
            OriginAccessControlOriginType: type,
          },
        }),
      );
      return created.OriginAccessControl.Id;
    } catch (err) {
      if ((err as { name?: string }).name !== "OriginAccessControlAlreadyExists") throw err;
      let marker: string | undefined;
      do {
        const list = await deps.cloudfront.send(new ListOriginAccessControlsCommand({ Marker: marker }));
        const found = (list.OriginAccessControlList?.Items ?? []).find((item: { Name: string }) => item.Name === name);
        if (found) return found.Id;
        marker = list.OriginAccessControlList?.IsTruncated ? list.OriginAccessControlList.NextMarker : undefined;
      } while (marker);
      throw err;
    }
  }

  async function putBucketStatements(spec: CdnComparable, distributionArn: string) {
    const policy = await readBucketPolicy(spec.bucket, spec.bucket_region);
    const id = tag(spec.domain);
    const objectArn = `arn:aws:s3:::${spec.bucket}/${spec.path}*`;
    const condition = { StringEquals: { "AWS:SourceArn": distributionArn } };
    const statements = policy.Statement.filter((s: { Sid?: string }) => !s.Sid?.startsWith(`cloudgear-cdn-${id}`));
    // The CDN only reads objects; earlier versions also granted ListBucket, which is dropped here on the next apply.
    statements.push({
      Sid: `cloudgear-cdn-${id}-read`,
      Effect: "Allow",
      Principal: { Service: CLOUDFRONT },
      Action: "s3:GetObject",
      Resource: objectArn,
      Condition: condition,
    });
    await deps.s3(spec.bucket_region).send(new PutBucketPolicyCommand({ Bucket: spec.bucket, Policy: JSON.stringify({ ...policy, Statement: statements }) }));
  }

  async function removeBucketStatements(spec: CdnComparable) {
    const policy = await readBucketPolicy(spec.bucket, spec.bucket_region);
    const id = `cloudgear-cdn-${tag(spec.domain)}`;
    const kept = policy.Statement.filter((s: { Sid?: string }) => !s.Sid?.startsWith(id));
    if (kept.length === policy.Statement.length) return;
    if (kept.length === 0) await deps.s3(spec.bucket_region).send(new DeleteBucketPolicyCommand({ Bucket: spec.bucket }));
    else await deps.s3(spec.bucket_region).send(new PutBucketPolicyCommand({ Bucket: spec.bucket, Policy: JSON.stringify({ ...policy, Statement: kept }) }));
  }

  async function readBucketPolicy(bucket: string, region?: string): Promise<{ Version: string; Statement: any[]; [key: string]: unknown }> {
    try {
      const res = await deps.s3(region).send(new GetBucketPolicyCommand({ Bucket: bucket }));
      const policy = JSON.parse(res.Policy);
      return { ...policy, Statement: Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement] };
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchBucketPolicy") return { Version: "2012-10-17", Statement: [] };
      throw err;
    }
  }

  async function allowDistribution(functionName: string, domain: string, distributionArn: string) {
    const permissions = [
      { Action: "lambda:InvokeFunctionUrl", kind: "url", FunctionUrlAuthType: "AWS_IAM" as const },
      { Action: "lambda:InvokeFunction", kind: "invoke", InvokedViaFunctionUrl: true },
    ];
    for (const { kind, ...permission } of permissions) {
      try {
        await deps.lambda.send(
          new AddPermissionCommand({
            FunctionName: functionName,
            StatementId: `cloudgear-cdn-${tag(domain)}-${kind}`,
            Principal: CLOUDFRONT,
            SourceArn: distributionArn,
            ...permission,
          }),
        );
      } catch (err) {
        const e = err as { name?: string; message?: string };
        if (!(e.name === "ResourceConflictException" && /statement id.*already exists/i.test(e.message ?? ""))) throw err;
      }
    }
  }

  async function revokeDistribution(functionName: string, domain: string) {
    for (const kind of ["url", "invoke"]) {
      try {
        await deps.lambda.send(
          new RemovePermissionCommand({ FunctionName: functionName, StatementId: `cloudgear-cdn-${tag(domain)}-${kind}` }),
        );
      } catch (err) {
        if ((err as { name?: string }).name !== "ResourceNotFoundException") throw err;
      }
    }
  }

  async function waitDeployed(id: string): Promise<boolean> {
    for (let attempt = 0; attempt < DEPLOY_ATTEMPTS; attempt++) {
      const res = await deps.cloudfront.send(new GetDistributionCommand({ Id: id }));
      if (res.Distribution?.Status === "Deployed") return true;
      await deps.sleep(POLL_MS);
    }
    deps.log(`distribution ${id} is still deploying; it will finish on its own`);
    return false;
  }

  // Creates or brings an existing distribution up to date; every step tolerates being run again.
  async function converge(entry: { deps: string[]; spec: Record<string, unknown> }, context: DriverContext, outputs: Record<string, string>) {
    const spec = entry.spec as unknown as CdnComparable;
    const certificate = context.entry(stateKey({ type: "@aws.Certificate", name: spec.domain }));
    if (!certificate?.outputs.arn) throw new Error(`Certificate for ${spec.domain} is not issued yet`);
    const origins = functionOrigins(entry, spec, context);

    // Fail before creating anything if the name already points somewhere that is not ours.
    const dns = await deps.dns(spec.dns_provider, spec.dns_zone);
    const record = await dns.get(spec.domain, "CNAME");
    if (record && !(outputs.domain_name && sameTarget(record.values[0], outputs.domain_name))) {
      throw new Error(`DNS record ${spec.domain} already exists (CNAME ${record.values[0]}); remove it or serve the site from another name`);
    }

    deps.log("creating origin access controls");
    outputs.oac_s3 = await ensureOac(`cloudgear-${spec.domain}-s3`, "s3", outputs.oac_s3);
    if (origins.size) outputs.oac_lambda = await ensureOac(`cloudgear-${spec.domain}-lambda`, "lambda", outputs.oac_lambda);

    const config = (reference: string, enabled = true) =>
      buildDistributionConfig(spec, { certificateArn: certificate.outputs.arn!, region: spec.bucket_region || deps.region, oacS3: outputs.oac_s3!, oacLambda: outputs.oac_lambda, origins, reference, enabled });

    if (!outputs.id) {
      deps.log(`creating the distribution for ${spec.domain}`);
      const created = await deps.cloudfront.send(new CreateDistributionCommand({ DistributionConfig: config(`cloudgear-${tag(spec.domain)}-${Date.now()}`) }));
      outputs.id = created.Distribution.Id;
      outputs.arn = created.Distribution.ARN;
      outputs.domain_name = created.Distribution.DomainName;
      deps.log(`distribution ${outputs.id} will be served from ${outputs.domain_name}`);
    } else {
      deps.log(`updating distribution ${outputs.id}`);
      const current = await deps.cloudfront.send(new GetDistributionConfigCommand({ Id: outputs.id }));
      await deps.cloudfront.send(
        new UpdateDistributionCommand({ Id: outputs.id, IfMatch: current.ETag, DistributionConfig: config(current.DistributionConfig.CallerReference) }),
      );
    }

    deps.log(`allowing the distribution to read ${spec.bucket} and call ${origins.size} function(s)`);
    await putBucketStatements(spec, outputs.arn!);
    for (const origin of origins.values()) await allowDistribution(origin.physical, spec.domain, outputs.arn!);
    deps.log(`pointing ${spec.domain} at ${outputs.domain_name}`);
    await dns.upsert({ name: spec.domain, type: "CNAME", values: [outputs.domain_name!], ttl: 300 });
    deps.log("waiting for the distribution to deploy");
    outputs.status = (await waitDeployed(outputs.id!)) ? "Deployed" : "InProgress";
    if (outputs.status === "Deployed") deps.log(`${spec.domain} is live`);
    return outputs;
  }

  return {
    async create(entry, context) {
      const outputs: Record<string, string> = {};
      try {
        return await converge(entry, context, outputs);
      } catch (err) {
        throw outputs.id || outputs.oac_s3 ? new PartialApplyError(err, outputs) : err;
      }
    },

    async update(entry, current, _changes, context) {
      const outputs = { ...current.outputs };
      const spec = entry.spec as unknown as CdnComparable;
      const before = servedFunctions(current.spec);
      try {
        await converge(entry, context, outputs);
        const stillServed = new Set(spec.behaviors.map((b) => b.function));
        for (const gone of before.filter((fn) => !stillServed.has(fn))) await revokeDistribution(gone, spec.domain);
        return outputs;
      } catch (err) {
        throw new PartialApplyError(err, outputs);
      }
    },

    async delete(current) {
      const spec = current.spec as unknown as Partial<CdnComparable>;
      const domain = spec.domain ?? current.name;
      // Only remove the record if it still points at the distribution this entry created.
      if (current.outputs.domain_name && spec.dns_provider && spec.dns_zone) {
        const dns = await deps.dns(spec.dns_provider, spec.dns_zone);
        const record = await dns.get(domain, "CNAME");
        if (record && sameTarget(record.values[0], current.outputs.domain_name)) await dns.remove(domain, "CNAME");
      }
      if (current.outputs.id) await removeDistribution(current.outputs.id);
      for (const key of ["oac_s3", "oac_lambda"]) {
        const id = current.outputs[key];
        if (!id) continue;
        await ignoreMissing(deps.cloudfront, new DeleteOriginAccessControlCommand({ Id: id, IfMatch: await etagOfOac(id) }), "NoSuchOriginAccessControl");
      }
      if (spec.bucket) await removeBucketStatements(spec as CdnComparable);
      for (const fn of servedFunctions(current.spec)) await revokeDistribution(fn, domain);
    },
  };

  async function removeDistribution(id: string) {
    let etag: string;
    try {
      const current = await deps.cloudfront.send(new GetDistributionConfigCommand({ Id: id }));
      etag = current.ETag;
      if (current.DistributionConfig.Enabled) {
        const disabled = await deps.cloudfront.send(
          new UpdateDistributionCommand({ Id: id, IfMatch: etag, DistributionConfig: { ...current.DistributionConfig, Enabled: false } }),
        );
        etag = disabled.ETag;
      }
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchDistribution") return;
      throw err;
    }
    // A distribution can only be deleted once disabling has propagated, and the ETag may have changed meanwhile.
    if (!(await waitDeployed(id))) throw new Error(`Distribution ${id} is still being disabled; run apply again in a few minutes`);
    try {
      etag = (await deps.cloudfront.send(new GetDistributionConfigCommand({ Id: id }))).ETag;
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchDistribution") return;
      throw err;
    }
    await ignoreMissing(deps.cloudfront, new DeleteDistributionCommand({ Id: id, IfMatch: etag }), "NoSuchDistribution");
  }

  async function etagOfOac(id: string): Promise<string | undefined> {
    try {
      return (await deps.cloudfront.send(new GetOriginAccessControlCommand({ Id: id }))).ETag;
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchOriginAccessControl") return undefined;
      throw err;
    }
  }
}

// Functions the entry serves or served: its (possibly attempted) spec plus the last one that fully applied.
function servedFunctions(spec: Record<string, unknown>): string[] {
  const names = (s: unknown) => ((s as Partial<CdnComparable> | undefined)?.behaviors ?? []).map((b) => b.function);
  return [...new Set([...names(spec), ...names(spec.previous)])];
}

async function ignoreMissing(client: SendClient, command: unknown, errorName: string) {
  try {
    await client.send(command);
  } catch (err) {
    if ((err as { name?: string }).name !== errorName) throw err;
  }
}

export interface DistributionInputs {
  certificateArn: string;
  region: string;
  oacS3: string;
  oacLambda?: string;
  origins: Map<string, FunctionOrigin>;
  reference: string;
  enabled: boolean;
}

// CloudFront routes by path only and allows just three method sets.
export function allowedMethods(methods: string[]): string[] {
  const set = new Set(methods);
  if ([...set].some((m) => !["GET", "HEAD", "OPTIONS"].includes(m))) return ALL_METHODS;
  return set.has("OPTIONS") ? ["GET", "HEAD", "OPTIONS"] : ["GET", "HEAD"];
}

export function buildDistributionConfig(spec: CdnComparable, input: DistributionInputs): DistributionConfig {
  const methodList = (items: string[]) => ({ Quantity: items.length, Items: items });
  const siteId = "cloudgear-site";
  const originPath = spec.path ? `/${spec.path.replace(/\/$/, "")}` : "";

  const origins = [
    {
      Id: siteId,
      DomainName: `${spec.bucket}.s3.${input.region}.amazonaws.com`,
      OriginPath: originPath,
      S3OriginConfig: { OriginAccessIdentity: "" },
      OriginAccessControlId: input.oacS3,
    },
    ...[...input.origins.values()].map((origin) => ({
      Id: `cloudgear-fn-${origin.physical}`,
      DomainName: origin.host,
      CustomOriginConfig: {
        HTTPPort: 80,
        HTTPSPort: 443,
        OriginProtocolPolicy: "https-only",
        OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
      },
      OriginAccessControlId: input.oacLambda,
    })),
  ];

  const behaviors = spec.behaviors.map((behavior) => {
    const methods = allowedMethods(behavior.methods);
    return {
      PathPattern: behavior.path_pattern,
      TargetOriginId: `cloudgear-fn-${behavior.function}`,
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: { ...methodList(methods), CachedMethods: methodList(["GET", "HEAD"]) },
      CachePolicyId: CACHING_DISABLED,
      OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
      Compress: true,
    };
  });

  return {
    CallerReference: input.reference,
    Comment: `cloudgear: ${spec.domain}`,
    Enabled: input.enabled,
    Aliases: { Quantity: 1, Items: [spec.domain] },
    DefaultRootObject: "index.html",
    HttpVersion: "http2and3",
    IsIPV6Enabled: true,
    Origins: { Quantity: origins.length, Items: origins },
    DefaultCacheBehavior: {
      TargetOriginId: siteId,
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: { ...methodList(["GET", "HEAD"]), CachedMethods: methodList(["GET", "HEAD"]) },
      CachePolicyId: CACHING_OPTIMIZED,
      Compress: true,
    },
    CacheBehaviors: { Quantity: behaviors.length, Items: behaviors },
    ViewerCertificate: {
      ACMCertificateArn: input.certificateArn,
      SSLSupportMethod: "sni-only",
      MinimumProtocolVersion: "TLSv1.2_2021",
    },
  } as DistributionConfig;
}

export async function invalidateDistribution(client: SendClient, distributionId: string, paths: string[]): Promise<string> {
  const res = await client.send(
    new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: { CallerReference: `cloudgear-${Date.now()}`, Paths: { Quantity: paths.length, Items: paths } },
    }),
  );
  return res.Invalidation?.Id ?? "";
}
