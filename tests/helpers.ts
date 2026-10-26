import type { CloudgearConfig, FunctionSpec } from "../src/config/schema";
import { apply } from "../src/deploy/apply";
import { awsDrivers, type SendClient } from "../src/deploy/aws";
import { plan } from "../src/deploy/plan";
import { MemoryDnsDriver } from "@cloudgear/dns/drivers/memory";
import type { State } from "../src/deploy/state";

export const fn = (overrides: Partial<FunctionSpec> = {}): FunctionSpec => ({
  name: "foo",
  type: "@aws.Lambda",
  physical_name: "app-foo",
  runtime: "nodejs22.x",
  memory_mb: 256,
  timeout_s: 10,
  source: { file: "server/api.ts", export: "foo" },
  route: [{ method: "POST", path: "/foo/{param}", name: "foo" }],
  bundle: { path: "build/foo/index.mjs", sha256: "v1" },
  permission: [{ resource: "data", path: "", action: ["s3:PutObject", "s3:ListBucket"] }],
  env: [{ key: "CLOUDGEAR_BLOB_DATA", value_from: "data" }],
  reserved_concurrency: 0,
  ...overrides,
});

export const baseConfig = (overrides: Partial<CloudgearConfig> = {}): CloudgearConfig => ({
  project: "app",
  provider: "aws",
  resource: [
    { name: "data", type: "@aws.S3", physical_name: "data", dry: false, source: "a.ts:1" },
    { name: "legacy", type: "@aws.S3", physical_name: "legacy", dry: true, source: "a.ts:2" },
  ],
  function: [fn()],
  invoker: [],
  authenticated: "iam",
  ...overrides,
});

export const emptyState = (): State => ({ version: 1, project: "app", provider: "aws", entries: {} });

// Records every SDK command and answers with canned responses.
export function fakeAws(overrides: Record<string, (input: any, attempt: number) => any> = {}, dns: MemoryDnsDriver | null = new MemoryDnsDriver(), onDns?: (provider: string, zone: string) => void) {
  const calls: { name: string; input: any }[] = [];
  const counts = new Map<string, number>();
  const sleeps: number[] = [];
  const logs: string[] = [];
  const defaults: Record<string, (input: any) => any> = {
    CreateRoleCommand: (input) => ({ Role: { Arn: `arn:aws:iam::1:role/${input.RoleName}` } }),
    CreateFunctionCommand: (input) => ({ FunctionArn: `arn:aws:lambda:x:1:function:${input.FunctionName}` }),
    GetFunctionConfigurationCommand: () => ({ State: "Active", LastUpdateStatus: "Successful" }),
    CreateFunctionUrlConfigCommand: (input) => ({ FunctionUrl: `https://${input.FunctionName}.lambda-url.eu-west-1.on.aws/` }),
    RequestCertificateCommand: () => ({ CertificateArn: "arn:aws:acm:us-east-1:1:certificate/c1" }),
    DescribeCertificateCommand: () => ({
      Certificate: {
        Status: "ISSUED",
        DomainValidationOptions: [{ ResourceRecord: { Name: "_v1.cdn.example.com.", Type: "CNAME", Value: "_v2.acm-validations.aws." } }],
      },
    }),
    CreateOriginAccessControlCommand: (input) => ({ OriginAccessControl: { Id: `oac-${input.OriginAccessControlConfig.OriginAccessControlOriginType}` } }),
    CreateDistributionCommand: () => ({
      Distribution: { Id: "E1", ARN: "arn:aws:cloudfront::1:distribution/E1", DomainName: "d111.cloudfront.net" },
      ETag: "e1",
    }),
    GetDistributionCommand: () => ({ Distribution: { Status: "Deployed" } }),
    GetDistributionConfigCommand: () => ({ ETag: "e1", DistributionConfig: { CallerReference: "ref-1", Enabled: true } }),
    UpdateDistributionCommand: () => ({ ETag: "e2" }),
    GetOriginAccessControlCommand: () => ({ ETag: "o1" }),
    GetBucketPolicyCommand: () => {
      throw Object.assign(new Error("no policy"), { name: "NoSuchBucketPolicy" });
    },
    CreateInvalidationCommand: () => ({ Invalidation: { Id: "I1" } }),
    PutRuleCommand: (input) => ({ RuleArn: `arn:aws:events:eu-west-1:1:rule/${input.Name}` }),
    PutTargetsCommand: () => ({ FailedEntryCount: 0 }),
  };
  const client: SendClient = {
    async send(command) {
      const name = command.constructor.name as string;
      const attempt = counts.get(name) ?? 0;
      counts.set(name, attempt + 1);
      calls.push({ name, input: command.input });
      const respond = overrides[name] ?? defaults[name];
      return respond ? respond(command.input, attempt) : {};
    },
  };
  const drivers = awsDrivers({
    region: "eu-west-1",
    readBundle: () => new TextEncoder().encode("export const handler = () => {};"),
    clients: { s3: client, lambda: client, iam: client, acm: client, cloudfront: client, events: client },
    dns: dns ? (provider, zone) => (onDns?.(provider, zone), dns) : undefined,
    sleep: async () => void sleeps.push(0),
    log: (message) => void logs.push(message),
  });
  return { calls, drivers, dns, sleeps, logs, names: () => calls.map((c) => c.name), of: (name: string) => calls.filter((c) => c.name === name).map((c) => c.input) };
}

export async function applyAll(config: CloudgearConfig, state: State, aws = fakeAws()) {
  await apply(plan(config, state), state, aws.drivers, { save: () => {} });
  return aws;
}

