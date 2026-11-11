import type { SecretBindingSpec } from "../../config/schema";

export interface SecretContext {
  account: string;
  region: string;
}

interface Statement {
  Effect: "Allow";
  Action: string[];
  Resource: string | string[];
}

const KMS_ID = /^(mrk-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^mrk-[0-9a-f]{32}$/i;

function keyArn(key: string, region: string, account: string): string {
  if (key.startsWith("arn:")) {
    if (/:alias\//.test(key)) throw new Error(`kmsKey "${key}" must be a key id or ARN; an alias cannot be scoped in IAM`);
    return key;
  }
  if (KMS_ID.test(key)) return `arn:aws:kms:${region}:${account}:key/${key}`;
  throw new Error(`kmsKey "${key}" must be a key id or ARN; an alias cannot be scoped in IAM`);
}

export function secretStatements(bindings: SecretBindingSpec[] | undefined, context: SecretContext): Statement[] {
  const read = new Map<string, Set<string>>();
  const byPath = new Map<string, Set<string>>();
  const list = new Set<string>();
  const decrypt = new Set<string>();
  const add = (map: Map<string, Set<string>>, action: string, resource: string) => {
    map.set(action, (map.get(action) ?? new Set()).add(resource));
  };
  for (const binding of bindings ?? []) {
    const region = binding.region ?? context.region;
    const base = (service: string) => `arn:aws:${service}:${region}:${context.account}`;
    if (binding.service === "ssm") {
      const parameter = (suffix: string) => `${base("ssm")}:parameter${binding.path}${suffix}`;
      if (binding.all) {
        add(byPath, "ssm:GetParametersByPath", parameter(""));
        add(byPath, "ssm:GetParametersByPath", parameter("/*"));
        add(read, "ssm:GetParameter", parameter("/*"));
        add(read, "ssm:GetParameters", parameter("/*"));
      } else {
        add(read, "ssm:GetParameter", parameter(`/${binding.name}`));
        add(read, "ssm:GetParameters", parameter(`/${binding.name}`));
      }
    } else {
      const secret = (suffix: string) => `${base("secretsmanager")}:secret:${binding.path}${suffix}`;
      add(read, "secretsmanager:GetSecretValue", binding.all ? secret("/*") : secret(`/${binding.name}-??????`));
      if (binding.all) list.add("*");
    }
    if (binding.kms_key) decrypt.add(keyArn(binding.kms_key, region, context.account));
  }
  const statements: Statement[] = [];
  for (const map of [read, byPath]) {
    const byResources = new Map<string, { actions: string[]; resources: string[] }>();
    for (const [action, resources] of map) {
      const key = [...resources].sort().join("\0");
      const group = byResources.get(key) ?? { actions: [], resources: [...resources].sort() };
      group.actions.push(action);
      byResources.set(key, group);
    }
    for (const group of byResources.values()) statements.push({ Effect: "Allow", Action: group.actions.sort(), Resource: group.resources.length === 1 ? group.resources[0]! : group.resources });
  }
  if (list.size) statements.push({ Effect: "Allow", Action: ["secretsmanager:ListSecrets"], Resource: "*" });
  if (decrypt.size) statements.push({ Effect: "Allow", Action: ["kms:Decrypt"], Resource: [...decrypt].sort() });
  return statements;
}
