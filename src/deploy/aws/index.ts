import {
  AttachRolePolicyCommand,
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  IAMClient,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  AddPermissionCommand,
  CreateFunctionCommand,
  CreateFunctionUrlConfigCommand,
  DeleteFunctionCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import { CreateBucketCommand, DeleteBucketCommand, S3Client, type BucketLocationConstraint } from "@aws-sdk/client-s3";
import type { Drivers } from "../apply";
import type { DesiredEntry, FunctionComparable } from "../plan";
import type { StateEntry } from "../state";
import type { FunctionSpec } from "../../config/schema";
import { zip } from "../../build/zip";

export interface SendClient {
  send(command: any): Promise<any>;
}

export interface AwsDriverOptions {
  region: string;
  readBundle: (fn: FunctionSpec) => Uint8Array;
  clients?: { s3?: SendClient; lambda?: SendClient; iam?: SendClient };
  sleep?: (ms: number) => Promise<void>;
}

const BASIC_EXECUTION_POLICY = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
const INLINE_POLICY = "cloudgear";
const LAMBDA_TRUST_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

export function awsDrivers(options: AwsDriverOptions): Drivers {
  const s3 = options.clients?.s3 ?? new S3Client({ region: options.region });
  const lambda = options.clients?.lambda ?? new LambdaClient({ region: options.region });
  const iam = options.clients?.iam ?? new IAMClient({ region: options.region });
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));

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

  async function putPermissions(roleName: string, spec: FunctionComparable) {
    if (!spec.permissions.length) {
      await ignore(iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: INLINE_POLICY })), "NoSuchEntity");
      return;
    }
    await iam.send(
      new PutRolePolicyCommand({ RoleName: roleName, PolicyName: INLINE_POLICY, PolicyDocument: policyDocument(spec) }),
    );
  }

  function environment(spec: FunctionComparable) {
    return { Variables: { NODE_OPTIONS: "--enable-source-maps", ...spec.env } };
  }

  return {
    "@aws.S3": {
      async create(entry) {
        await s3.send(
          new CreateBucketCommand({
            Bucket: entry.physical_name,
            CreateBucketConfiguration:
              options.region === "us-east-1"
                ? undefined
                : { LocationConstraint: options.region as BucketLocationConstraint },
          }),
        );
        return { arn: `arn:aws:s3:::${entry.physical_name}` };
      },
      async update() {
        return {};
      },
      async delete(current) {
        await ignore(s3.send(new DeleteBucketCommand({ Bucket: current.physical_name })), "NoSuchBucket");
      },
    },

    "@aws.Lambda": {
      async create(entry: DesiredEntry) {
        const spec = entry.spec as unknown as FunctionComparable;
        const roleName = roleNameFor(entry.physical_name);
        const role = await iam.send(new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: LAMBDA_TRUST_POLICY }));
        await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: BASIC_EXECUTION_POLICY }));
        await putPermissions(roleName, spec);

        const code = zip([{ name: "index.mjs", data: options.readBundle(entry.source as FunctionSpec) }]);
        let created: any;
        // A new IAM role takes a few seconds before Lambda can assume it.
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
              }),
            );
            break;
          } catch (err) {
            if (attempt >= 10 || !/cannot be assumed/i.test((err as Error).message)) throw err;
            await sleep(3000);
          }
        }
        await waitForFunction(entry.physical_name);

        const url = await lambda.send(new CreateFunctionUrlConfigCommand({ FunctionName: entry.physical_name, AuthType: "NONE" }));
        await lambda.send(
          new AddPermissionCommand({
            FunctionName: entry.physical_name,
            StatementId: "cloudgear-url",
            Action: "lambda:InvokeFunctionUrl",
            Principal: "*",
            FunctionUrlAuthType: "NONE",
          }),
        );
        await lambda.send(
          new AddPermissionCommand({
            FunctionName: entry.physical_name,
            StatementId: "cloudgear-url-invoke",
            Action: "lambda:InvokeFunction",
            Principal: "*",
            InvokedViaFunctionUrl: true,
          }),
        );
        return { arn: created.FunctionArn, role_name: roleName, role_arn: role.Role.Arn, url: url.FunctionUrl };
      },

      async update(entry, current, changes) {
        const spec = entry.spec as unknown as FunctionComparable;
        const roleName = current.outputs.role_name ?? roleNameFor(entry.physical_name);
        if (changes.includes("permissions")) await putPermissions(roleName, spec);
        if (changes.includes("code")) {
          const code = zip([{ name: "index.mjs", data: options.readBundle(entry.source as FunctionSpec) }]);
          await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: entry.physical_name, ZipFile: code }));
          await waitForFunction(entry.physical_name);
        }
        if (changes.includes("config")) {
          await lambda.send(
            new UpdateFunctionConfigurationCommand({
              FunctionName: entry.physical_name,
              Runtime: spec.runtime as any,
              MemorySize: spec.memory_mb,
              Timeout: spec.timeout_s,
              Environment: environment(spec),
            }),
          );
          await waitForFunction(entry.physical_name);
        }
        return {};
      },

      async delete(current: StateEntry) {
        const roleName = current.outputs.role_name ?? roleNameFor(current.physical_name);
        await ignore(lambda.send(new DeleteFunctionCommand({ FunctionName: current.physical_name })), "ResourceNotFoundException");
        await ignore(iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: INLINE_POLICY })), "NoSuchEntity");
        await ignore(iam.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: BASIC_EXECUTION_POLICY })), "NoSuchEntity");
        await ignore(iam.send(new DeleteRoleCommand({ RoleName: roleName })), "NoSuchEntity");
      },
    },
  };
}

export function policyDocument(spec: FunctionComparable): string {
  const statements = spec.permissions.flatMap((p) => {
    if (p.type !== "@aws.S3") throw new Error(`No IAM mapping for permissions on ${p.type}`);
    const bucketArn = `arn:aws:s3:::${p.physical_name}`;
    const bucketActions = p.actions.filter((a) => a === "s3:ListBucket");
    const objectActions = p.actions.filter((a) => a !== "s3:ListBucket");
    return [
      ...(objectActions.length ? [{ Effect: "Allow", Action: objectActions, Resource: `${bucketArn}/*` }] : []),
      ...(bucketActions.length ? [{ Effect: "Allow", Action: bucketActions, Resource: bucketArn }] : []),
    ];
  });
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

function roleNameFor(functionName: string): string {
  return `${functionName.slice(0, 59)}-role`;
}

async function ignore(promise: Promise<unknown>, errorName: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if ((err as { name?: string }).name !== errorName) throw err;
  }
}
