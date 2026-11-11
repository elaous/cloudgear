import {
  AttachRolePolicyCommand,
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  AddPermissionCommand,
  DeleteFunctionConcurrencyCommand,
  PutFunctionConcurrencyCommand,
  RemovePermissionCommand,
  UpdateFunctionUrlConfigCommand,
  DeleteFunctionUrlConfigCommand,
  CreateFunctionCommand,
  CreateFunctionUrlConfigCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  GetFunctionUrlConfigCommand,
  LambdaClient,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { createHash } from "node:crypto";
import { ACMClient } from "@aws-sdk/client-acm";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { ApiGatewayV2Client } from "@aws-sdk/client-apigatewayv2";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { timed } from "@cloudgear/debug";
import type { DnsDriver } from "@cloudgear/dns";
import { CreateBucketCommand, DeleteBucketCommand, GetBucketPolicyCommand, HeadBucketCommand, PutBucketTaggingCommand, PutBucketVersioningCommand, S3Client, type BucketLocationConstraint } from "@aws-sdk/client-s3";
import type { DriverContext, Drivers } from "../apply";
import type { DesiredEntry, FunctionComparable } from "../plan";
import type { StateEntry } from "../state";
import type { FunctionSpec, SecretRefSpec } from "../../config/schema";
import { environmentOptions } from "../../providers";
import { secretStatements, type SecretContext } from "./secrets";
import { zip } from "../../build/zip";
import { fitName } from "../../names";
import { expectArn, parseArn } from "./arn";
import { taggerFor, tagList, type Tags } from "./tags";
import { certificateDriver } from "./certificate";
import { apiGatewayDriver } from "./apigateway";
import { cloudFrontDriver } from "./cloudfront";
import { scheduleDriver } from "./schedule";
import { eventBusDriver, eventRuleDriver } from "./eventbus";

export interface SendClient {
  send(command: any): Promise<any>;
}

export interface AwsDriverOptions {
  region: string;
  readBundle: (fn: FunctionSpec) => Uint8Array;
  readIncluded?: (fn: FunctionSpec) => { name: string; data: Uint8Array }[];
  clients?: { s3?: SendClient; lambda?: SendClient; iam?: SendClient; acm?: SendClient; cloudfront?: SendClient; events?: SendClient; apigateway?: SendClient };
  // Entry's own zone, so removals still clean up.
  dns?: (provider: string, zone: string, token?: SecretRefSpec) => DnsDriver | Promise<DnsDriver>;
  // Also tags each resource with its logical name.
  tags?: Tags;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const BASIC_EXECUTION_POLICY = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
const INLINE_POLICY = "cloudgear";

// IAM's limit on all the inline policies of one role together.
const MAX_ROLE_POLICY_CHARS = 10_240;

// Shared imported roles get a per-function policy.
const policyNameFor = (roleName: string, functionName: string) =>
  roleName === roleNameFor(functionName) ? INLINE_POLICY : fitName(`${INLINE_POLICY}-${functionName}`, 128);
const LAMBDA_TRUST_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

function withDebug(service: string, client: SendClient): SendClient {
  return { send: (command) => timed(`aws.${service}`, command.constructor.name, () => client.send(command), () => ({ request: command.input })) };
}

export function awsDrivers(options: AwsDriverOptions): Drivers {
  // Buckets may sit in other regions; one client per region.
  const s3Clients = new Map<string, SendClient>();
  const s3For = (region?: string): SendClient => {
    const wanted = region || options.region;
    if (options.clients?.s3) return withDebug("s3", options.clients.s3);
    if (!s3Clients.has(wanted)) s3Clients.set(wanted, withDebug(`s3:${wanted}`, new S3Client({ region: wanted })));
    return s3Clients.get(wanted)!;
  };
  const lambda = withDebug("lambda", options.clients?.lambda ?? new LambdaClient({ region: options.region }));
  const iam = withDebug("iam", options.clients?.iam ?? new IAMClient({ region: options.region }));
  const tagsFor = taggerFor(options.tags);
  const tagger = options.tags ? tagsFor : undefined;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const acmClients = new Map<string, SendClient>();
  const acmFor = (region: string): SendClient => {
    if (options.clients?.acm) return withDebug("acm", options.clients.acm);
    if (!acmClients.has(region)) acmClients.set(region, withDebug(`acm:${region}`, new ACMClient({ region })));
    return acmClients.get(region)!;
  };
  // CloudFront's API is global, reached through us-east-1.
  const cloudfront = withDebug("cloudfront", options.clients?.cloudfront ?? new CloudFrontClient({ region: "us-east-1" }));
  const apigateway = withDebug("apigateway", options.clients?.apigateway ?? new ApiGatewayV2Client({ region: options.region }));
  const events = withDebug("events", options.clients?.events ?? new EventBridgeClient({ region: options.region }));
  const zones = new Map<string, Promise<DnsDriver>>();
  const requireDns = (provider: string, zone: string, token?: SecretRefSpec): Promise<DnsDriver> => {
    if (!options.dns) throw new Error("A DNS driver is required for the certificate and CDN, but none was configured");
    const key = `${provider}/${zone}`;
    if (!zones.has(key)) zones.set(key, Promise.resolve(options.dns(provider, zone, token)));
    return zones.get(key)!;
  };
  const log = options.log ?? (() => {});

  async function waitForFunction(name: string) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const config = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
      if (config.State === "Failed" || config.LastUpdateStatus === "Failed") {
        throw new Error(`Lambda ${name} failed: ${config.StateReason ?? config.LastUpdateStatusReason}`);
      }
      if (config.State === "Active" && config.LastUpdateStatus !== "InProgress") return;
      await sleep(2000);
    }
    throw new Error(`Timed out waiting for Lambda ${name} to become active`);
  }

  // The role's own policies as JSON documents, and an index of the managed ones that are attached.
  async function exportRolePolicies(roleName: string, skip: string[], notes: string[]): Promise<{ path: string; content: string }[]> {
    const files: { path: string; content: string }[] = [];
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    const safe = (name: string) => name.replace(/[^A-Za-z0-9_+=,.@-]/g, "_");
    // IAM allows "." and ".." as names; they must not become directories.
    const folder = /^\.+$/.test(roleName) ? `role-${roleName.length}-dots` : safe(roleName);
    const decode = (document: unknown) => {
      if (typeof document !== "string") return document;
      try {
        return JSON.parse(decodeURIComponent(document));
      } catch {
        return JSON.parse(document);
      }
    };
    const used = new Set<string>();
    const place = (stem: string) => {
      let path = `${folder}/${stem}.json`;
      for (let n = 2; used.has(path); n++) path = `${folder}/${stem}-${n}.json`;
      used.add(path);
      return path;
    };
    const missing: string[] = [];
    const inline: string[] = [];
    let marker: string | undefined;
    do {
      const page = await iam.send(new ListRolePoliciesCommand({ RoleName: roleName, Marker: marker }));
      for (const name of (page.PolicyNames ?? []) as string[]) {
        if (skip.includes(name)) continue;
        try {
          const got = await iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: name }));
          files.push({ path: place(`inline-${safe(name)}`), content: json(decode(got.PolicyDocument)) });
          inline.push(name);
        } catch (err) {
          if ((err as { name?: string }).name !== "NoSuchEntity") throw err;
          missing.push(name);
        }
      }
      marker = page.IsTruncated ? page.Marker : undefined;
    } while (marker);
    const customerManaged: { name: string; arn: string }[] = [];
    const awsManaged: string[] = [];
    marker = undefined;
    do {
      const page = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName, Marker: marker }));
      for (const attached of (page.AttachedPolicies ?? []) as { PolicyName: string; PolicyArn: string }[]) {
        if (attached.PolicyArn.includes(":iam::aws:policy/")) {
          awsManaged.push(attached.PolicyArn);
          continue;
        }
        try {
          const policy = await iam.send(new GetPolicyCommand({ PolicyArn: attached.PolicyArn }));
          const version = await iam.send(new GetPolicyVersionCommand({ PolicyArn: attached.PolicyArn, VersionId: policy.Policy.DefaultVersionId }));
          files.push({ path: place(`managed-${safe(attached.PolicyName)}`), content: json(decode(version.PolicyVersion.Document)) });
          customerManaged.push({ name: attached.PolicyName, arn: attached.PolicyArn });
        } catch (err) {
          if ((err as { name?: string }).name !== "NoSuchEntity") throw err;
          missing.push(attached.PolicyName);
        }
      }
      marker = page.IsTruncated ? page.Marker : undefined;
    } while (marker);
    files.push({ path: `${folder}/index.json`, content: json({ role: roleName, inline, customerManaged, awsManaged, ...(missing.length ? { removedWhileReading: missing } : {}) }) });
    notes.push(`the policies of role ${roleName} were exported (${inline.length} inline, ${customerManaged.length} customer-managed, ${awsManaged.length} AWS-managed); cloudgear does not manage them. The role's permissions boundary and trust policy are not exported`);
    return files;
  }

  // PutRolePolicy can fail with NoSuchEntity for a moment after the role was created.
  async function putRolePolicy(input: { RoleName: string; PolicyName: string; PolicyDocument: string }) {
    for (let attempt = 0; ; attempt++) {
      try {
        await iam.send(new PutRolePolicyCommand(input));
        return;
      } catch (err) {
        if (attempt >= 5 || (err as { name?: string }).name !== "NoSuchEntity") throw err;
        await sleep(2000);
      }
    }
  }

  // A policy name another function on the same role (an imported, shared one) still declares is not this function's to remove.
  const declaredElsewhere = (name: string, roleName: string, self: string, context?: DriverContext) =>
    (context?.entries?.() ?? []).some(
      (other) => other.type === "@aws.Lambda" && other.physical_name !== self && other.outputs.role_name === roleName && ((other.spec.policies as { name: string }[] | undefined) ?? []).some((p) => p.name === name),
    );

  // The policy cloudgear infers, and the ones declared with `Policy`; `previous` are names declared before, that may be gone now.
  async function putPermissions(roleName: string, spec: FunctionComparable, roleArn?: string, previous: string[] = [], context?: DriverContext) {
    const declared = spec.policies ?? [];
    const inferred = !spec.permissions.length && !traced(spec) && !spec.secrets?.length
      ? undefined
      : policyDocument(spec, spec.secrets?.length || spec.permissions.some((p) => p.type === "@aws.EventBus") ? { account: accountOf(roleArn), region: options.region } : undefined);
    // IAM counts all the inline policies of a role together.
    const total = (inferred?.length ?? 0) + declared.reduce((sum, policy) => sum + policy.document.length, 0);
    if (total > MAX_ROLE_POLICY_CHARS) {
      throw new Error(`The inline policies of ${roleName} would total ${total} characters (cloudgear's own ${inferred?.length ?? 0}, declared ${total - (inferred?.length ?? 0)}); IAM allows ${MAX_ROLE_POLICY_CHARS} per role`);
    }
    // Removed ones first, so that a replacement of similar size fits.
    for (const name of previous) {
      if (!declared.some((policy) => policy.name === name) && !declaredElsewhere(name, roleName, spec.physical_name, context)) {
        await ignore(iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: name })), "NoSuchEntity");
      }
    }
    const own = policyNameFor(roleName, spec.physical_name);
    if (inferred === undefined) await ignore(iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: own })), "NoSuchEntity");
    else await putRolePolicy({ RoleName: roleName, PolicyName: own, PolicyDocument: inferred });
    for (const policy of declared) await putRolePolicy({ RoleName: roleName, PolicyName: policy.name, PolicyDocument: policy.document });
  }

  const statementId = (kind: string, principal: string) =>
    `cloudgear-${kind}-${createHash("sha256").update(principal).digest("hex").slice(0, 12)}`;

  // "Update in progress" errors must not be skipped.
  const addPermission = async (input: ConstructorParameters<typeof AddPermissionCommand>[0]) => {
    try {
      await lambda.send(new AddPermissionCommand(input));
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e.name === "ResourceConflictException" && /statement id.*already exists/i.test(e.message ?? "")) return;
      throw err;
    }
  };

  async function addInvokers(functionName: string, principals: string[]) {
    for (const principal of principals) {
      await addPermission({
        FunctionName: functionName,
        StatementId: statementId("url", principal),
        Action: "lambda:InvokeFunctionUrl",
        Principal: principal,
        FunctionUrlAuthType: "AWS_IAM",
      });
      await addPermission({
        FunctionName: functionName,
        StatementId: statementId("invoke", principal),
        Action: "lambda:InvokeFunction",
        Principal: principal,
        InvokedViaFunctionUrl: true,
      });
    }
  }

  async function removeInvokers(functionName: string, principals: string[]) {
    for (const principal of principals) {
      for (const kind of ["url", "invoke"]) {
        await ignore(
          lambda.send(new RemovePermissionCommand({ FunctionName: functionName, StatementId: statementId(kind, principal) })),
          "ResourceNotFoundException",
        );
      }
    }
  }

  const PUBLIC_STATEMENTS = ["cloudgear-public-url", "cloudgear-public-invoke"];

  async function addPublic(functionName: string) {
    await addPermission({
      FunctionName: functionName,
      StatementId: PUBLIC_STATEMENTS[0],
      Action: "lambda:InvokeFunctionUrl",
      Principal: "*",
      FunctionUrlAuthType: "NONE",
    });
    await addPermission({
      FunctionName: functionName,
      StatementId: PUBLIC_STATEMENTS[1],
      Action: "lambda:InvokeFunction",
      Principal: "*",
      InvokedViaFunctionUrl: true,
    });
  }

  async function removePublic(functionName: string) {
    for (const id of PUBLIC_STATEMENTS) {
      await ignore(
        lambda.send(new RemovePermissionCommand({ FunctionName: functionName, StatementId: id })),
        "ResourceNotFoundException",
      );
    }
  }

  async function setConcurrency(functionName: string, reserved: number) {
    if (reserved > 0) {
      await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: functionName, ReservedConcurrentExecutions: reserved }));
    } else {
      await ignore(lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName: functionName })), "ResourceNotFoundException");
    }
  }

  async function setVersioning(bucket: string, region: string, enabled: boolean) {
    await s3For(region).send(
      new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: enabled ? "Enabled" : "Suspended" } }),
    );
  }

  function environment(spec: FunctionComparable) {
    return { Variables: { NODE_OPTIONS: "--enable-source-maps", ...spec.env, ...environmentOptions(spec.options) } };
  }

  function lambdaOptions(spec: FunctionComparable) {
    return {
      TracingConfig: { Mode: (spec.options?.tracing ?? "PassThrough") as "Active" | "PassThrough" },
      EphemeralStorage: { Size: Number(spec.options?.ephemeral_storage_mb ?? 512) },
    };
  }

  return {
    "@aws.Schedule": scheduleDriver({ events, lambda, log, tags: tagger }),
    "@aws.EventBus": eventBusDriver({ events, lambda, log, tags: tagger }),
    "@aws.EventRule": eventRuleDriver({ events, lambda, log, tags: tagger }),
    "@aws.Certificate": certificateDriver({ tags: tagger, acm: acmFor, region: options.region, dns: requireDns, sleep, log }),
    "@aws.CloudFront": cloudFrontDriver({ tags: tagger, cloudfront, s3: s3For, lambda, dns: requireDns, region: options.region, sleep, log }),
    "@aws.ApiGateway": apiGatewayDriver({ tags: tagger, apigateway, lambda, dns: requireDns, region: options.region, log }),
    "@aws.S3": {
      async create(entry) {
        const region = (entry.spec.region as string | undefined) || options.region;
        await s3For(region).send(
          new CreateBucketCommand({
            Bucket: entry.physical_name,
            CreateBucketConfiguration:
              region === "us-east-1" ? undefined : { LocationConstraint: region as BucketLocationConstraint },
          }),
        );
        try {
          if (options.tags) await s3For(region).send(new PutBucketTaggingCommand({ Bucket: entry.physical_name, Tagging: { TagSet: tagList(tagsFor(entry.name)) } }));
          if (entry.spec.options && (entry.spec.options as Record<string, string>).versioning === "true") {
            await setVersioning(entry.physical_name, region, true);
          }
        } catch (err) {
          await s3For(region).send(new DeleteBucketCommand({ Bucket: entry.physical_name })).catch(() => {});
          throw err;
        }
        return { arn: `arn:aws:s3:::${entry.physical_name}`, region };
      },
      async adopt(entry, _context, hint) {
        const region = (entry.spec.region as string | undefined) || options.region;
        if (hint?.arn) {
          const bucket = expectArn(hint.arn, "s3", "an S3 bucket").resource;
          if (bucket !== entry.physical_name) throw new Error(`${hint.arn} is the bucket "${bucket}", but the config uses "${entry.physical_name}"`);
        }
        try {
          await s3For(region).send(new HeadBucketCommand({ Bucket: entry.physical_name }));
        } catch (err) {
          const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
          const status = e.$metadata?.httpStatusCode;
          if (e.name === "NotFound" || e.name === "NoSuchBucket" || status === 404) return undefined;
          if (status === 403 || e.name === "Forbidden") throw new Error(`bucket "${entry.physical_name}" exists but these credentials cannot read it (it may belong to another account)`);
          if (status === 301 || e.name === "PermanentRedirect") throw new Error(`bucket "${entry.physical_name}" is not in ${region}; set its region with new BlobStore(..., { region })`);
          throw err;
        }
        const adopted: { outputs: Record<string, string>; files?: { path: string; content: string }[]; notes: string[] } = { outputs: { arn: `arn:aws:s3:::${entry.physical_name}`, region }, notes: [] };
        if (hint?.exportPolicies) {
          try {
            const got = await s3For(region).send(new GetBucketPolicyCommand({ Bucket: entry.physical_name }));
            const document = typeof got.Policy === "string" ? JSON.parse(got.Policy) : got.Policy;
            adopted.files = [{ path: `buckets/${entry.physical_name}/policy.json`, content: `${JSON.stringify(document, null, 2)}\n` }];
            adopted.notes.push(`its bucket policy was exported; cloudgear adds only its own CDN statement to it, and the rest stays as it is`);
          } catch (err) {
            const name = (err as { name?: string }).name;
            adopted.notes.push(name === "NoSuchBucketPolicy" ? "it has no bucket policy to export" : `its bucket policy could not be exported (${(err as Error).message})`);
          }
        }
        return adopted;
      },
      async update(entry, current) {
        const before = (current.spec.region as string | undefined) || current.outputs.region || options.region;
        const after = (entry.spec.region as string | undefined) || options.region;
        if (before !== after) {
          throw new Error(
            `Bucket "${entry.physical_name}" cannot move from region "${before}" to "${after}"; destroy it (after emptying it) and apply again`,
          );
        }
        const wanted = (entry.spec.options as Record<string, string> | undefined)?.versioning === "true";
        const had = (current.spec.options as Record<string, string> | undefined)?.versioning === "true";
        if (wanted !== had) await setVersioning(entry.physical_name, after, wanted);
        return {};
      },
      async delete(current) {
        const region = (current.spec.region as string | undefined) || current.outputs.region;
        try {
          await s3For(region).send(new DeleteBucketCommand({ Bucket: current.physical_name }));
        } catch (err) {
          const name = (err as { name?: string }).name;
          if (name === "NoSuchBucket") return;
          if (name === "BucketNotEmpty") {
            throw new Error(`Bucket "${current.physical_name}" is not empty; empty it, or run cloudgear import to keep it, then retry`);
          }
          throw err;
        }
      },
    },

    "@aws.Lambda": {
      async create(entry: DesiredEntry) {
        const spec = entry.spec as unknown as FunctionComparable;
        const roleName = roleNameFor(entry.physical_name);
        // Undo steps for what this call created, on failure.
        const undo: (() => Promise<unknown>)[] = [];
        try {
          const role = await iam.send(new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: LAMBDA_TRUST_POLICY, ...(options.tags ? { Tags: tagList(tagsFor(entry.name)) } : {}) }));
          undo.push(() => iam.send(new DeleteRoleCommand({ RoleName: roleName })));
          await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: BASIC_EXECUTION_POLICY }));
          undo.push(() => iam.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: BASIC_EXECUTION_POLICY })));
          // Registered before the puts: a role that still holds a policy cannot be deleted.
          undo.push(() => iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: INLINE_POLICY })));
          for (const policy of spec.policies ?? []) undo.push(() => iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policy.name })));
          await putPermissions(roleName, spec, role.Role.Arn);

          const code = zip([{ name: "index.mjs", data: options.readBundle(entry.source as FunctionSpec) }, ...(options.readIncluded?.(entry.source as FunctionSpec) ?? [])]);
          let created: any;
          // A new IAM role takes seconds before Lambda can assume it.
          for (let attempt = 0; ; attempt++) {
            try {
              created = await lambda.send(
                new CreateFunctionCommand({
                  FunctionName: entry.physical_name,
                  Runtime: spec.runtime as any,
                  Role: role.Role.Arn,
                  Handler: "index.handler",
                  Code: { ZipFile: code },
                  MemorySize: spec.memory_mb,
                  Timeout: spec.timeout_s,
                  Environment: environment(spec),
                  ...(options.tags ? { Tags: tagsFor(entry.name) } : {}),
                  ...lambdaOptions(spec),
                }),
              );
              break;
            } catch (err) {
              if (attempt >= 10 || !/cannot be assumed/i.test((err as Error).message)) throw err;
              await sleep(3000);
            }
          }
          undo.push(() => lambda.send(new DeleteFunctionCommand({ FunctionName: entry.physical_name })));
          await waitForFunction(entry.physical_name);

          const routed = (entry.source as FunctionSpec).route.length > 0;
          const url = routed
            ? await lambda.send(new CreateFunctionUrlConfigCommand({ FunctionName: entry.physical_name, AuthType: urlAuthType(spec.auth) }))
            : undefined;
          if (routed) {
            if (spec.auth === "iam") await addInvokers(entry.physical_name, spec.invokers);
            else await addPublic(entry.physical_name);
          }
          if (spec.reserved_concurrency > 0) await setConcurrency(entry.physical_name, spec.reserved_concurrency);
          return { arn: created.FunctionArn, role_name: roleName, role_arn: role.Role.Arn, ...(url ? { url: url.FunctionUrl } : {}) };
        } catch (err) {
          for (const step of undo.reverse()) await step().catch(() => {});
          throw err;
        }
      },

      async adopt(entry, _context, hint) {
        const spec = entry.spec as unknown as FunctionComparable;
        if (hint?.arn) {
          const parsed = expectArn(hint.arn, "lambda", "a Lambda function");
          const [kind, named, qualifier] = parsed.resource.split(":");
          if (kind !== "function" || !named) throw new Error(`"${hint.arn}" is not a Lambda function ARN`);
          if (qualifier) throw new Error(`${hint.arn} names a version or alias; give the function's own ARN (without ":${qualifier}")`);
          if (named !== entry.physical_name) throw new Error(`${hint.arn} is the function "${named}", but the config deploys "${entry.physical_name}"`);
          if (parsed.region !== options.region) throw new Error(`${hint.arn} is in ${parsed.region}, but the functions are deployed to ${options.region}`);
        }
        try {
          const found = await lambda.send(new GetFunctionCommand({ FunctionName: entry.physical_name }));
          const config = found.Configuration as { FunctionArn?: string; Role?: string; PackageType?: string; Handler?: string; Environment?: { Variables?: Record<string, string> } } | undefined;
          if (!config?.FunctionArn) return undefined;
          if (hint?.arn && parseArn(config.FunctionArn)?.account !== parseArn(hint.arn)?.account) throw new Error(`${hint.arn} is in another account than the function that was found (${config.FunctionArn})`);
          if (config.PackageType === "Image") throw new Error(`function "${entry.physical_name}" is a container image; cloudgear deploys zip bundles and cannot manage it`);
          const url = await lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: entry.physical_name })).then(
            (res: { FunctionUrl?: string; AuthType?: string }) => res,
            (err: { name?: string }) => {
              if (err.name === "ResourceNotFoundException") return undefined;
              throw err;
            },
          );
          const notes: string[] = [];
          const extra = Object.keys(config.Environment?.Variables ?? {}).filter((key) => !(key in environment(spec).Variables));
          if (extra.length) notes.push(`its environment variables not in the config will be removed: ${extra.sort().join(", ")}`);
          if (config.Handler && config.Handler !== "index.handler") notes.push(`its handler "${config.Handler}" will become index.handler, and its code is replaced by the bundle`);
          if ((spec.policies ?? []).length) notes.push(`the policies declared for it (${spec.policies!.map((p) => p.name).join(", ")}) are put on role ${config.Role?.split("/").at(-1) ?? "its role"} by name, overwriting a policy of that name already there, and are removed again if they leave the code`);
          const concurrency = (found as { Concurrency?: { ReservedConcurrentExecutions?: number } }).Concurrency?.ReservedConcurrentExecutions;
          const roleName = config.Role?.split("/").at(-1);
          let files: { path: string; content: string }[] | undefined;
          if (hint?.exportPolicies) {
            if (!roleName) notes.push("it has no role, so there are no policies to export");
            else {
              // The policies cloudgear writes on a role are left out, but only on its own role: a policy of that name on another role is the user's.
              const own = roleName === roleNameFor(entry.physical_name) ? [INLINE_POLICY] : [policyNameFor(roleName, entry.physical_name)];
              try {
                files = await exportRolePolicies(roleName, own, notes);
              } catch (err) {
                notes.push(`the policies of role ${roleName} could not be exported (${(err as Error).message}); the function is imported anyway`);
              }
            }
          }
          return {
            ...(files ? { files } : {}),
            outputs: {
              arn: config.FunctionArn,
              ...(config.Role ? { role_arn: config.Role, role_name: config.Role.split("/").at(-1)! } : {}),
              ...(url?.FunctionUrl ? { url: url.FunctionUrl } : {}),
            },
            spec: { reserved_concurrency: concurrency ?? 0, ...(url?.AuthType ? { auth: url.AuthType === "NONE" ? "none" : "iam" } : {}) },
            notes,
          };
        } catch (err) {
          if ((err as { name?: string }).name === "ResourceNotFoundException") return undefined;
          throw err;
        }
      },

      async update(entry, current, changes, context) {
        const spec = entry.spec as unknown as FunctionComparable;
        const roleName = current.outputs.role_name ?? roleNameFor(entry.physical_name);
        const tracingChanged = traced(spec) !== ((current.spec.options as Record<string, string> | undefined)?.tracing === "Active");
        if (changes.includes("permissions") || tracingChanged) await putPermissions(roleName, spec, current.outputs.role_arn, ((current.spec.policies as { name: string }[] | undefined) ?? []).map((p) => p.name), context);
        if (changes.includes("code")) {
          const code = zip([{ name: "index.mjs", data: options.readBundle(entry.source as FunctionSpec) }, ...(options.readIncluded?.(entry.source as FunctionSpec) ?? [])]);
          await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: entry.physical_name, ZipFile: code }));
          await waitForFunction(entry.physical_name);
        }
        if (changes.includes("config")) {
          await lambda.send(
            new UpdateFunctionConfigurationCommand({
              FunctionName: entry.physical_name,
              Runtime: spec.runtime as any,
              Handler: "index.handler",
              MemorySize: spec.memory_mb,
              Timeout: spec.timeout_s,
              Environment: environment(spec),
              ...lambdaOptions(spec),
            }),
          );
          await waitForFunction(entry.physical_name);
          const previous = Number(current.spec.reserved_concurrency ?? 0);
          if (spec.reserved_concurrency !== previous) await setConcurrency(entry.physical_name, spec.reserved_concurrency);
        }
        const before = (current.spec.invokers as string[] | undefined) ?? [];
        if (spec.scheduled_only && current.outputs.url) {
          await ignore(lambda.send(new DeleteFunctionUrlConfigCommand({ FunctionName: entry.physical_name })), "ResourceNotFoundException");
          if ((current.spec.auth ?? "iam") === "iam") await removeInvokers(entry.physical_name, before);
          else await removePublic(entry.physical_name);
          return { url: "" };
        }
        if (!current.outputs.url) {
          if (!(entry.source as FunctionSpec).route.length) return {} as Record<string, string>;
          const url = await lambda.send(
            new CreateFunctionUrlConfigCommand({ FunctionName: entry.physical_name, AuthType: urlAuthType(spec.auth) }),
          );
          if (spec.auth === "iam") await addInvokers(entry.physical_name, spec.invokers);
          else await addPublic(entry.physical_name);
          return { url: url.FunctionUrl as string };
        }
        if (changes.includes("auth")) {
          await lambda.send(
            new UpdateFunctionUrlConfigCommand({ FunctionName: entry.physical_name, AuthType: urlAuthType(spec.auth) }),
          );
          if ((current.spec.auth ?? "iam") === "iam") await removeInvokers(entry.physical_name, before);
          else await removePublic(entry.physical_name);
          if (spec.auth === "iam") await addInvokers(entry.physical_name, spec.invokers);
          else await addPublic(entry.physical_name);
        } else if (changes.includes("invokers")) {
          await removeInvokers(entry.physical_name, before.filter((p) => !spec.invokers.includes(p)));
          await addInvokers(entry.physical_name, spec.invokers.filter((p) => !before.includes(p)));
        }
        return {};
      },

      async delete(current: StateEntry, context) {
        const roleName = current.outputs.role_name ?? roleNameFor(current.physical_name);
        await ignore(lambda.send(new DeleteFunctionCommand({ FunctionName: current.physical_name })), "ResourceNotFoundException");
        await ignore(iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyNameFor(roleName, current.physical_name) })), "NoSuchEntity");
        // The policies declared with `Policy` are cloudgear's to remove, even from a role it leaves in place.
        for (const policy of (current.spec.policies as { name: string }[] | undefined) ?? []) {
          if (declaredElsewhere(policy.name, roleName, current.physical_name, context)) continue;
          await ignore(iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policy.name })), "NoSuchEntity");
        }
        // Imported roles may be shared; leave them in place.
        if (roleName !== roleNameFor(current.physical_name)) return;
        await ignore(iam.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: BASIC_EXECUTION_POLICY })), "NoSuchEntity");
        await ignore(iam.send(new DeleteRoleCommand({ RoleName: roleName })), "NoSuchEntity");
      },
    },
  };
}

function accountOf(roleArn: string | undefined): string {
  const account = roleArn?.split(":")[4];
  if (!account) throw new Error("The function's role has no ARN in state; destroy and apply it again to grant it secrets");
  return account;
}

export function policyDocument(spec: FunctionComparable, secrets?: SecretContext): string {
  const statements = spec.permissions.flatMap((p) => {
    if (p.type === "@aws.EventBus") {
      if (!secrets) throw new Error("The account and region are needed to grant a function its event buses");
      return [{ Effect: "Allow", Action: p.actions, Resource: `arn:aws:events:${secrets.region}:${secrets.account}:event-bus/${p.physical_name}` }];
    }
    if (p.type !== "@aws.S3") throw new Error(`No IAM mapping for permissions on ${p.type}`);
    const bucketArn = `arn:aws:s3:::${p.physical_name}`;
    const prefix = p.path ?? "";
    const bucketActions = p.actions.filter((a) => a === "s3:ListBucket");
    const objectActions = p.actions.filter((a) => a !== "s3:ListBucket");
    return [
      ...(objectActions.length ? [{ Effect: "Allow", Action: objectActions, Resource: `${bucketArn}/${prefix}*` }] : []),
      ...(bucketActions.length
        ? [
            {
              Effect: "Allow",
              Action: bucketActions,
              Resource: bucketArn,
              ...(prefix ? { Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } } } : {}),
            },
          ]
        : []),
    ];
  });
  if (traced(spec)) {
    statements.push({ Effect: "Allow", Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource: "*" } as never);
  }
  if (spec.secrets?.length) {
    if (!secrets) throw new Error("The account and region are needed to grant a function its secrets");
    statements.push(...(secretStatements(spec.secrets, secrets) as never[]));
  }
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

function traced(spec: FunctionComparable): boolean {
  return spec.options?.tracing === "Active";
}

function urlAuthType(auth: "iam" | "none"): "AWS_IAM" | "NONE" {
  return auth === "iam" ? "AWS_IAM" : "NONE";
}

function roleNameFor(functionName: string): string {
  return fitName(`${functionName}-role`, 64);
}

async function ignore(promise: Promise<unknown>, errorName: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if ((err as { name?: string }).name !== errorName) throw err;
  }
}
