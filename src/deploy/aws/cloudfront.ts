import { createHash } from "node:crypto";
import {
  CreateDistributionCommand,
  CreateDistributionWithTagsCommand,
  CreateFunctionCommand as CreateEdgeFunctionCommand,
  CreateInvalidationCommand,
  CreateOriginAccessControlCommand,
  DeleteDistributionCommand,
  DeleteFunctionCommand as DeleteEdgeFunctionCommand,
  DeleteOriginAccessControlCommand,
  DescribeFunctionCommand,
  type DistributionConfig,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  GetOriginAccessControlCommand,
  ListDistributionsCommand,
  ListOriginAccessControlsCommand,
  PublishFunctionCommand,
  UpdateDistributionCommand,
  UpdateFunctionCommand as UpdateEdgeFunctionCommand,
} from "@aws-sdk/client-cloudfront";
import { AddPermissionCommand, GetPolicyCommand, RemovePermissionCommand } from "@aws-sdk/client-lambda";
import { DeleteBucketPolicyCommand, GetBucketPolicyCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3";
import type { DnsDriver } from "@cloudgear/dns";
import type { SecretRefSpec } from "../../config/schema";
import { fitName } from "../../names";
import { expectArn } from "./arn";
import { sameTarget } from "./certificate";
import { PartialApplyError, type Driver, type DriverContext } from "../apply";
import type { CdnComparable } from "../plan";
import { stateKey } from "../state";
import type { SendClient } from "./index";
import { originIdOf, routeFunctionCode } from "./route-function";
import { tagList, type Tagger } from "./tags";

export interface CloudFrontDeps {
  tags?: Tagger;
  cloudfront: SendClient;
  s3: (region?: string) => SendClient;
  lambda: SendClient;
  dns: (provider: string, zone: string, token?: SecretRefSpec) => Promise<DnsDriver>;
  region: string;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

const DEPLOY_ATTEMPTS = 180;
const POLL_MS = 10_000;
const CLOUDFRONT = "cloudfront.amazonaws.com";
const MAX_FUNCTION_BYTES = 10 * 1024;
const ALL_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"];

interface FunctionOrigin {
  physical: string;
  host: string;
}

export function cloudFrontDriver(deps: CloudFrontDeps): Driver {
  const tag = (domain: string) => createHash("sha256").update(domain).digest("hex").slice(0, 12);

  function functionOrigins(entry: { deps: string[] }, spec: CdnComparable, context: DriverContext): Map<string, FunctionOrigin> {
    const origins = new Map<string, FunctionOrigin>();
    for (const name of servedFunctions(spec, false)) {
      const fn = entry.deps
        .map((key) => context.entry(key))
        .find((e) => e?.type === "@aws.Lambda" && e.physical_name === name);
      if (!fn?.outputs.url) throw new Error(`Function "${name}" has no URL yet; apply it first`);
      origins.set(name, { physical: name, host: new URL(fn.outputs.url).host });
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
    // Grants read only; earlier ListBucket grants are dropped.
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
      const statementId = `cloudgear-cdn-${tag(domain)}-${kind}`;
      const grant = () =>
        deps.lambda.send(new AddPermissionCommand({ FunctionName: functionName, StatementId: statementId, Principal: CLOUDFRONT, SourceArn: distributionArn, ...permission }));
      try {
        await grant();
      } catch (err) {
        const e = err as { name?: string; message?: string };
        if (!(e.name === "ResourceConflictException" && /statement id.*already exists/i.test(e.message ?? ""))) throw err;
        if (await grantsSource(functionName, statementId, distributionArn)) continue;
        await removeStatement(functionName, statementId);
        await grant();
      }
    }
  }

  async function grantsSource(functionName: string, statementId: string, sourceArn: string): Promise<boolean> {
    const { Policy } = await deps.lambda.send(new GetPolicyCommand({ FunctionName: functionName }));
    const statements: { Sid?: string; Condition?: { ArnLike?: Record<string, string> } }[] = [].concat(JSON.parse(Policy).Statement ?? []);
    return statements.some((s) => s.Sid === statementId && s.Condition?.ArnLike?.["AWS:SourceArn"] === sourceArn);
  }

  async function removeStatement(functionName: string, statementId: string) {
    try {
      await deps.lambda.send(new RemovePermissionCommand({ FunctionName: functionName, StatementId: statementId }));
    } catch (err) {
      if ((err as { name?: string }).name !== "ResourceNotFoundException") throw err;
    }
  }

  async function revokeDistribution(functionName: string, domain: string) {
    for (const kind of ["url", "invoke"]) await removeStatement(functionName, `cloudgear-cdn-${tag(domain)}-${kind}`);
  }

  async function publishRouteFunction(spec: CdnComparable, outputs: Record<string, string>): Promise<string> {
    const name = fitName(`cloudgear-${tag(spec.domain)}-routes`, 64);
    const code = Buffer.from(routeFunctionCode(spec.method_routes ?? []));
    if (code.length > MAX_FUNCTION_BYTES) throw new Error(`The routing function for ${spec.domain} is ${code.length} bytes; CloudFront Functions allow ${MAX_FUNCTION_BYTES}. Serve fewer routes through the CDN`);
    const config = { Comment: `cloudgear: ${spec.domain}`, Runtime: "cloudfront-js-2.0" as const };
    const exists = async () => {
      try {
        return (await deps.cloudfront.send(new DescribeFunctionCommand({ Name: name, Stage: "DEVELOPMENT" }))).ETag as string;
      } catch (err) {
        if ((err as { name?: string }).name === "NoSuchFunctionExists") return undefined;
        throw err;
      }
    };
    let etag = outputs.route_function ? await exists() : undefined;
    if (etag) {
      await deps.cloudfront.send(new UpdateEdgeFunctionCommand({ Name: name, IfMatch: etag, FunctionConfig: config, FunctionCode: code }));
    } else {
      try {
        await deps.cloudfront.send(new CreateEdgeFunctionCommand({ Name: name, FunctionConfig: config, FunctionCode: code }));
      } catch (err) {
        if ((err as { name?: string }).name !== "FunctionAlreadyExists") throw err;
        etag = await exists();
        await deps.cloudfront.send(new UpdateEdgeFunctionCommand({ Name: name, IfMatch: etag, FunctionConfig: config, FunctionCode: code }));
      }
    }
    outputs.route_function = name;
    etag = await exists();
    const published = await deps.cloudfront.send(new PublishFunctionCommand({ Name: name, IfMatch: etag }));
    return published.FunctionSummary.FunctionMetadata.FunctionARN;
  }

  async function removeRouteFunction(name: string) {
    try {
      const described = await deps.cloudfront.send(new DescribeFunctionCommand({ Name: name, Stage: "DEVELOPMENT" }));
      await deps.cloudfront.send(new DeleteEdgeFunctionCommand({ Name: name, IfMatch: described.ETag }));
    } catch (err) {
      if ((err as { name?: string }).name !== "NoSuchFunctionExists") throw err;
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

  // Idempotent: creates or updates the distribution.
  async function converge(entry: { deps: string[]; spec: Record<string, unknown> }, context: DriverContext, outputs: Record<string, string>) {
    const spec = entry.spec as unknown as CdnComparable;
    const certificate = context.entry(stateKey({ type: "@aws.Certificate", name: spec.certificate_domain ?? spec.domain }));
    if (!certificate?.outputs.arn) throw new Error(`Certificate for ${spec.certificate_domain ?? spec.domain} is not issued yet`);

    // Fail if the name points at a foreign distribution.
    const dns = await deps.dns(spec.dns_provider, spec.dns_zone, spec.dns_token);
    const record = await dns.get(spec.domain, "CNAME");
    if (record && !(outputs.domain_name && sameTarget(record.values[0], outputs.domain_name))) {
      throw new Error(`DNS record ${spec.domain} already exists (CNAME ${record.values[0]}); remove it or serve the site from another name`);
    }

    const origins = functionOrigins(entry, spec, context);
    deps.log("creating origin access controls");
    if (spec.bucket) outputs.oac_s3 = await ensureOac(`cloudgear-${spec.domain}-s3`, "s3", outputs.oac_s3);
    if (origins.size) outputs.oac_lambda = await ensureOac(`cloudgear-${spec.domain}-lambda`, "lambda", outputs.oac_lambda);
    let routeFunctionArn: string | undefined;
    if (spec.method_routes?.length) {
      deps.log("publishing the routing function");
      routeFunctionArn = await publishRouteFunction(spec, outputs);
    }

    const config = (reference: string, enabled = true) =>
      buildDistributionConfig(spec, {
        certificateArn: certificate.outputs.arn!,
        region: spec.bucket_region || deps.region,
        oacS3: outputs.oac_s3,
        oacLambda: outputs.oac_lambda,
        origins,
        routeFunctionArn,
        reference,
        enabled,
      });

    if (!outputs.id) {
      deps.log(`creating the distribution for ${spec.domain}`);
      const distributionConfig = config(`cloudgear-${tag(spec.domain)}-${Date.now()}`);
      const created = await deps.cloudfront.send(
        deps.tags
          ? new CreateDistributionWithTagsCommand({ DistributionConfigWithTags: { DistributionConfig: distributionConfig, Tags: { Items: tagList(deps.tags(spec.domain)) } } })
          : new CreateDistributionCommand({ DistributionConfig: distributionConfig }),
      );
      outputs.id = created.Distribution.Id;
      outputs.arn = created.Distribution.ARN;
      outputs.domain_name = created.Distribution.DomainName;
      outputs.url = `https://${outputs.domain_name}`;
      deps.log(`distribution ${outputs.id} will be served from ${outputs.domain_name}`);
    } else {
      deps.log(`updating distribution ${outputs.id}`);
      const current = await deps.cloudfront.send(new GetDistributionConfigCommand({ Id: outputs.id }));
      await deps.cloudfront.send(
        new UpdateDistributionCommand({ Id: outputs.id, IfMatch: current.ETag, DistributionConfig: config(current.DistributionConfig.CallerReference) }),
      );
    }

    if (spec.bucket) {
      deps.log(`allowing the distribution to read ${spec.bucket}`);
      await putBucketStatements(spec, outputs.arn!);
    }
    if (origins.size) {
      deps.log(`allowing the distribution to call ${origins.size} function(s)`);
      for (const origin of origins.values()) await allowDistribution(origin.physical, spec.domain, outputs.arn!);
    }
    deps.log(`pointing ${spec.domain} at ${outputs.domain_name}`);
    await dns.upsert({ name: spec.domain, type: "CNAME", values: [outputs.domain_name!], ttl: 300 });
    deps.log("waiting for the distribution to deploy");
    outputs.status = (await waitDeployed(outputs.id!)) ? "Deployed" : "InProgress";
    if (outputs.status === "Deployed") deps.log(`${spec.domain} is live`);
    return outputs;
  }

  return {
    async adopt(entry, _context, hint) {
      const spec = entry.spec as unknown as CdnComparable;
      const found = (item: { Id: string; ARN: string; DomainName: string; Status?: string }) => ({
        outputs: { id: item.Id, arn: item.ARN, domain_name: item.DomainName, url: `https://${item.DomainName}`, status: item.Status === "Deployed" ? "Deployed" : "InProgress" },
      });
      if (hint?.arn) {
        const id = /^distribution\/([A-Z0-9]+)$/.exec(expectArn(hint.arn, "cloudfront", "a CloudFront distribution").resource)?.[1];
        if (!id) throw new Error(`"${hint.arn}" is not a CloudFront distribution ARN`);
        let got;
        try {
          got = await deps.cloudfront.send(new GetDistributionCommand({ Id: id }));
        } catch (err) {
          if ((err as { name?: string }).name === "NoSuchDistribution") return undefined;
          throw err;
        }
        const distribution = got.Distribution as { Id: string; ARN: string; DomainName: string; Status?: string; DistributionConfig?: { Aliases?: { Items?: string[] } } };
        const aliases = distribution.DistributionConfig?.Aliases?.Items ?? [];
        if (!aliases.includes(spec.domain)) throw new Error(`${hint.arn} does not answer to ${spec.domain} (its aliases: ${aliases.join(", ") || "none"})`);
        return { ...found({ ...distribution, ARN: hint.arn }), notes: await overwritten(id) };
      }
      let marker: string | undefined;
      do {
        const list = await deps.cloudfront.send(new ListDistributionsCommand({ Marker: marker }));
        const item = (list.DistributionList?.Items ?? []).find((candidate: { Aliases?: { Items?: string[] } }) => candidate.Aliases?.Items?.includes(spec.domain));
        if (item) return { ...found(item), notes: await overwritten(item.Id) };
        marker = list.DistributionList?.IsTruncated ? list.DistributionList.NextMarker : undefined;
      } while (marker);
      return undefined;
    },

    async create(entry, context) {
      const outputs: Record<string, string> = {};
      try {
        return await converge(entry, context, outputs);
      } catch (err) {
        throw outputs.id || outputs.oac_s3 || outputs.oac_lambda || outputs.route_function ? new PartialApplyError(err, outputs) : err;
      }
    },

    async update(entry, current, _changes, context) {
      const outputs = { ...current.outputs };
      const spec = entry.spec as unknown as CdnComparable;
      const before = servedFunctions(current.spec);
      try {
        await converge(entry, context, outputs);
        const stillServed = new Set(servedFunctions(spec, false));
        for (const gone of before.filter((name) => !stillServed.has(name))) await revokeDistribution(gone, spec.domain);
        if (!stillServed.size && outputs.oac_lambda) {
          await ignoreMissing(deps.cloudfront, new DeleteOriginAccessControlCommand({ Id: outputs.oac_lambda, IfMatch: await etagOfOac(outputs.oac_lambda) }), "NoSuchOriginAccessControl");
          outputs.oac_lambda = "";
        }
        if (!spec.method_routes?.length && outputs.route_function) {
          await removeRouteFunction(outputs.route_function);
          outputs.route_function = "";
        }
        return outputs;
      } catch (err) {
        throw new PartialApplyError(err, outputs);
      }
    },

    async delete(current) {
      const spec = current.spec as unknown as Partial<CdnComparable>;
      const domain = spec.domain ?? current.name;
      // Remove the record only while it points at this distribution.
      if (current.outputs.domain_name && spec.dns_provider && spec.dns_zone) {
        const dns = await deps.dns(spec.dns_provider, spec.dns_zone, spec.dns_token);
        const record = await dns.get(domain, "CNAME");
        if (record && sameTarget(record.values[0], current.outputs.domain_name)) await dns.remove(domain, "CNAME");
      }
      if (current.outputs.id) await removeDistribution(current.outputs.id);
      for (const oac of [current.outputs.oac_s3, current.outputs.oac_lambda]) {
        if (oac) {
          await ignoreMissing(deps.cloudfront, new DeleteOriginAccessControlCommand({ Id: oac, IfMatch: await etagOfOac(oac) }), "NoSuchOriginAccessControl");
        }
      }
      if (current.outputs.route_function) await removeRouteFunction(current.outputs.route_function);
      for (const fn of servedFunctions(current.spec)) await revokeDistribution(fn, domain);
      if (spec.bucket) await removeBucketStatements(spec as CdnComparable);
    },
  };

  // Apply rebuilds the config; these existing settings are dropped.
  async function overwritten(id: string): Promise<string[]> {
    const got = await deps.cloudfront.send(new GetDistributionConfigCommand({ Id: id }));
    const config = (got.DistributionConfig ?? {}) as Record<string, any>;
    const notes: string[] = [];
    if (config.WebACLId) notes.push(`its web ACL (${config.WebACLId}) will be detached`);
    if (config.Logging?.Enabled) notes.push("its access logging will be turned off");
    if (config.CustomErrorResponses?.Quantity) notes.push(`its ${config.CustomErrorResponses.Quantity} custom error response(s) will be removed`);
    if (config.Restrictions?.GeoRestriction?.RestrictionType && config.Restrictions.GeoRestriction.RestrictionType !== "none") notes.push("its geo restriction will be removed");
    if (config.CacheBehaviors?.Quantity) notes.push(`its ${config.CacheBehaviors.Quantity} path behavior(s) will be replaced by the ones from the config`);
    if (config.Origins?.Quantity) notes.push(`its ${config.Origins.Quantity} origin(s) will be replaced by the ones from the config`);
    if (config.PriceClass && config.PriceClass !== "PriceClass_All") notes.push(`its price class (${config.PriceClass}) will be reset unless the config sets price_class`);
    return notes;
  }

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
    // Deletion waits for disabling to propagate; ETag may change.
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

function servedFunctions(spec: object, withPrevious = true): string[] {
  const names = (s: unknown) => {
    const comparable = s as Partial<CdnComparable> | undefined;
    return [...(comparable?.behaviors ?? []).map((b) => b.function), ...(comparable?.method_routes ?? []).map((r) => r.function)];
  };
  return [...new Set([...names(spec), ...(withPrevious ? names((spec as { previous?: unknown }).previous) : [])])].sort();
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
  oacS3?: string;
  oacLambda?: string;
  origins?: Map<string, FunctionOrigin>;
  routeFunctionArn?: string;
  reference: string;
  enabled: boolean;
}

// CloudFront allows just three method sets per behavior.
export function allowedMethods(methods: string[]): string[] {
  const set = new Set(methods);
  if ([...set].some((m) => !["GET", "HEAD", "OPTIONS"].includes(m))) return ALL_METHODS;
  return set.has("OPTIONS") ? ["GET", "HEAD", "OPTIONS"] : ["GET", "HEAD"];
}

export function buildDistributionConfig(spec: CdnComparable, input: DistributionInputs): DistributionConfig {
  const methodList = (items: string[]) => ({ Quantity: items.length, Items: items });
  const siteId = "cloudgear-site";
  const originPath = spec.path ? `/${spec.path.replace(/\/$/, "")}` : "";

  const siteOrigins = spec.bucket
    ? [
        {
          Id: siteId,
          DomainName: `${spec.bucket}.s3.${input.region}.amazonaws.com`,
          OriginPath: originPath,
          S3OriginConfig: { OriginAccessIdentity: "" },
          OriginAccessControlId: input.oacS3,
        },
      ]
    : [];
  const originMap = input.origins ?? new Map<string, FunctionOrigin>();
  const functionOrigins = [...originMap.values()].map((origin) => ({
    Id: originIdOf(origin.physical),
    DomainName: origin.host,
    CustomOriginConfig: {
      HTTPPort: 80,
      HTTPSPort: 443,
      OriginProtocolPolicy: "https-only",
      OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
    },
    OriginAccessControlId: input.oacLambda,
  }));
  const origins = [...siteOrigins, ...functionOrigins];

  const toFunction = {
    CachePolicyId: CACHING_DISABLED,
    OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
    ViewerProtocolPolicy: "https-only",
  };
  const behaviors = (spec.behaviors ?? []).map((behavior) => ({
    PathPattern: behavior.pattern,
    TargetOriginId: originIdOf(behavior.function),
    AllowedMethods: { ...methodList(allowedMethods(behavior.methods)), CachedMethods: methodList(["GET", "HEAD"]) },
    ...toFunction,
  }));

  const defaultBehavior = spec.bucket
    ? {
        TargetOriginId: siteId,
        ViewerProtocolPolicy: "redirect-to-https",
        AllowedMethods: { ...methodList(["GET", "HEAD"]), CachedMethods: methodList(["GET", "HEAD"]) },
        CachePolicyId: CACHING_OPTIMIZED,
        Compress: true,
      }
    : {
        // Unmatched paths reach the first function, which answers 404.
        TargetOriginId: originIdOf(functionOrigins.length ? [...originMap.keys()].sort()[0]! : ""),
        AllowedMethods: { ...methodList(ALL_METHODS), CachedMethods: methodList(["GET", "HEAD"]) },
        ...toFunction,
        ...(input.routeFunctionArn
          ? { FunctionAssociations: { Quantity: 1, Items: [{ EventType: "viewer-request", FunctionARN: input.routeFunctionArn }] } }
          : {}),
      };

  return {
    CallerReference: input.reference,
    Comment: `cloudgear: ${spec.domain}`,
    Enabled: input.enabled,
    Aliases: { Quantity: 1, Items: [spec.domain] },
    ...(spec.bucket ? { DefaultRootObject: spec.options?.default_root_object ?? "index.html" } : {}),
    ...(spec.options?.price_class ? { PriceClass: spec.options.price_class } : {}),
    HttpVersion: "http2and3",
    IsIPV6Enabled: true,
    Origins: { Quantity: origins.length, Items: origins },
    DefaultCacheBehavior: defaultBehavior,
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
