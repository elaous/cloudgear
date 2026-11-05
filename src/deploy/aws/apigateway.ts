import { createHash } from "node:crypto";
import {
  CreateApiCommand,
  CreateApiMappingCommand,
  CreateDomainNameCommand,
  CreateIntegrationCommand,
  CreateRouteCommand,
  CreateStageCommand,
  DeleteApiCommand,
  DeleteApiMappingCommand,
  DeleteDomainNameCommand,
  DeleteIntegrationCommand,
  DeleteRouteCommand,
  GetApiMappingsCommand,
  GetDomainNameCommand,
  GetIntegrationsCommand,
  GetRoutesCommand,
  UpdateDomainNameCommand,
  UpdateIntegrationCommand,
  UpdateRouteCommand,
} from "@aws-sdk/client-apigatewayv2";
import { AddPermissionCommand, GetPolicyCommand, RemovePermissionCommand } from "@aws-sdk/client-lambda";
import type { DnsDriver } from "@cloudgear/dns";
import type { SecretRefSpec } from "../../config/schema";
import { PartialApplyError, type Driver, type DriverContext } from "../apply";
import type { ApiComparable } from "../plan";
import { stateKey } from "../state";
import { sameTarget } from "./certificate";
import type { SendClient } from "./index";
import { type Tagger } from "./tags";

export interface ApiGatewayDeps {
  tags?: Tagger;
  apigateway: SendClient;
  lambda: SendClient;
  dns: (provider: string, zone: string, token?: SecretRefSpec) => Promise<DnsDriver>;
  region: string;
  log: (message: string) => void;
}

const STAGE = "$default";

async function all<T>(read: (token?: string) => Promise<{ Items?: T[]; NextToken?: string }>): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined;
  do {
    const page = await read(token);
    items.push(...(page.Items ?? []));
    token = page.NextToken;
  } while (token);
  return items;
}

const named = (error: unknown, ...names: string[]) => names.includes((error as { name?: string }).name ?? "");

async function ignoreMissing(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if (!named(err, "NotFoundException", "ResourceNotFoundException")) throw err;
  }
}

// Functions in the current spec or the last fully applied one.
function servedFunctions(spec: Record<string, unknown>): string[] {
  const names = (s: unknown) => ((s as Partial<ApiComparable> | undefined)?.routes ?? []).map((route) => route.function);
  return [...new Set([...names(spec), ...names(spec.previous)])];
}

export function apiGatewayDriver(deps: ApiGatewayDeps): Driver {
  const tag = (domain: string) => createHash("sha256").update(domain).digest("hex").slice(0, 12);
  const statementId = (domain: string) => `cloudgear-api-${tag(domain)}`;

  function functionArns(entry: { deps: string[] }, spec: ApiComparable, context: DriverContext): Map<string, string> {
    const arns = new Map<string, string>();
    for (const route of spec.routes) {
      if (arns.has(route.function)) continue;
      const fn = entry.deps.map((key) => context.entry(key)).find((e) => e?.type === "@aws.Lambda" && e.physical_name === route.function);
      if (!fn?.outputs.arn) throw new Error(`Function "${route.function}" has no ARN yet; apply it first`);
      arns.set(route.function, fn.outputs.arn);
    }
    return arns;
  }

  async function allow(functionName: string, functionArn: string, spec: ApiComparable, apiId: string) {
    const [, , , region, account] = functionArn.split(":");
    const sourceArn = `arn:aws:execute-api:${region}:${account}:${apiId}/*/*`;
    const grant = () =>
      deps.lambda.send(
        new AddPermissionCommand({
          FunctionName: functionName,
          StatementId: statementId(spec.domain),
          Action: "lambda:InvokeFunction",
          Principal: "apigateway.amazonaws.com",
          SourceArn: sourceArn,
        }),
      );
    try {
      await grant();
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (!(e.name === "ResourceConflictException" && /statement id.*already exists/i.test(e.message ?? ""))) throw err;
      if (await grantsSource(functionName, statementId(spec.domain), sourceArn)) return;
      await revoke(functionName, spec.domain);
      await grant();
    }
  }

  async function grantsSource(functionName: string, id: string, sourceArn: string): Promise<boolean> {
    const { Policy } = await deps.lambda.send(new GetPolicyCommand({ FunctionName: functionName }));
    const statements: { Sid?: string; Condition?: { ArnLike?: Record<string, string> } }[] = [].concat(JSON.parse(Policy).Statement ?? []);
    return statements.some((s) => s.Sid === id && s.Condition?.ArnLike?.["AWS:SourceArn"] === sourceArn);
  }

  async function revoke(functionName: string, domain: string) {
    await ignoreMissing(deps.lambda.send(new RemovePermissionCommand({ FunctionName: functionName, StatementId: statementId(domain) })));
  }

  async function converge(
    entry: { deps: string[]; spec: Record<string, unknown> },
    context: DriverContext,
    outputs: Record<string, string>,
    served: string[] = [],
  ): Promise<Record<string, string>> {
    const spec = entry.spec as unknown as ApiComparable;
    const region = spec.region || deps.region;
    const certificate = context.entry(stateKey({ type: "@aws.Certificate", name: spec.domain }));
    if (!certificate?.outputs.arn) throw new Error(`Certificate for ${spec.domain} is not issued yet`);
    if (certificate.outputs.arn.split(":")[3] !== region) {
      throw new Error(`The certificate for ${spec.domain} is in ${certificate.outputs.arn.split(":")[3]} but the API is in ${region}; they must match`);
    }
    const arns = functionArns(entry, spec, context);

    const dns = await deps.dns(spec.dns_provider, spec.dns_zone, spec.dns_token);
    const record = await dns.get(spec.domain, "CNAME");
    if (record && !(outputs.domain_name && sameTarget(record.values[0], outputs.domain_name))) {
      throw new Error(`DNS record ${spec.domain} already exists (CNAME ${record.values[0]}); remove it or serve the API from another name`);
    }

    if (!outputs.api_id) {
      deps.log(`creating the API for ${spec.domain}`);
      const created = await deps.apigateway.send(
        new CreateApiCommand({ Name: `cloudgear-${spec.domain}`, ProtocolType: "HTTP", Description: "Managed by cloudgear", ...(deps.tags ? { Tags: deps.tags(spec.domain) } : {}) }),
      );
      outputs.api_id = created.ApiId;
      outputs.api_endpoint = created.ApiEndpoint;
    }
    const apiId = outputs.api_id!;

    deps.log(`connecting ${spec.routes.length} route(s) to ${arns.size} function(s)`);
    const integrations = await all<{ IntegrationId: string; IntegrationUri?: string; Description?: string }>((token) =>
      deps.apigateway.send(new GetIntegrationsCommand({ ApiId: apiId, NextToken: token })).then((r: any) => ({ Items: r.Items, NextToken: r.NextToken })),
    );
    const integrationOf = new Map<string, string>();
    for (const [physical, arn] of arns) {
      const existing = integrations.find((i) => i.Description === physical);
      if (!existing) {
        const created = await deps.apigateway.send(
          new CreateIntegrationCommand({ ApiId: apiId, IntegrationType: "AWS_PROXY", IntegrationUri: arn, PayloadFormatVersion: "2.0", Description: physical }),
        );
        integrationOf.set(physical, created.IntegrationId);
      } else {
        if (existing.IntegrationUri !== arn) {
          await deps.apigateway.send(new UpdateIntegrationCommand({ ApiId: apiId, IntegrationId: existing.IntegrationId, IntegrationUri: arn }));
        }
        integrationOf.set(physical, existing.IntegrationId);
      }
    }

    const routes = await all<{ RouteId: string; RouteKey: string; Target?: string }>((token) =>
      deps.apigateway.send(new GetRoutesCommand({ ApiId: apiId, NextToken: token })).then((r: any) => ({ Items: r.Items, NextToken: r.NextToken })),
    );
    const wanted = new Map(spec.routes.map((route) => [route.key, `integrations/${integrationOf.get(route.function)}`]));
    for (const [routeKey, target] of wanted) {
      const existing = routes.find((r) => r.RouteKey === routeKey);
      if (!existing) {
        await deps.apigateway.send(new CreateRouteCommand({ ApiId: apiId, RouteKey: routeKey, Target: target, AuthorizationType: "NONE" }));
      } else if (existing.Target !== target) {
        await deps.apigateway.send(new UpdateRouteCommand({ ApiId: apiId, RouteId: existing.RouteId, Target: target }));
      }
    }
    for (const route of routes) {
      if (!wanted.has(route.RouteKey) && !route.RouteKey.startsWith("$")) {
        await deps.apigateway.send(new DeleteRouteCommand({ ApiId: apiId, RouteId: route.RouteId }));
      }
    }
    const used = new Set(integrationOf.values());
    for (const integration of integrations) {
      if (!used.has(integration.IntegrationId)) {
        await deps.apigateway.send(new DeleteIntegrationCommand({ ApiId: apiId, IntegrationId: integration.IntegrationId }));
      }
    }

    deps.log("allowing API Gateway to invoke the functions");
    for (const [physical, arn] of arns) await allow(physical, arn, spec, apiId);
    for (const gone of served.filter((fn) => !arns.has(fn))) await revoke(gone, spec.domain);

    try {
      await deps.apigateway.send(new CreateStageCommand({ ApiId: apiId, StageName: STAGE, AutoDeploy: true }));
    } catch (err) {
      if (!named(err, "ConflictException")) throw err;
    }

    deps.log(`creating the custom domain ${spec.domain}`);
    const configuration = [{ CertificateArn: certificate.outputs.arn, EndpointType: "REGIONAL", SecurityPolicy: "TLS_1_2" }];
    let domain: any;
    try {
      domain = await deps.apigateway.send(new GetDomainNameCommand({ DomainName: spec.domain }));
    } catch (err) {
      if (!named(err, "NotFoundException")) throw err;
    }
    const mappings = domain
      ? await all<{ ApiMappingId: string; ApiId: string; ApiMappingKey?: string }>((token) =>
          deps.apigateway.send(new GetApiMappingsCommand({ DomainName: spec.domain, NextToken: token })).then((r: any) => ({ Items: r.Items, NextToken: r.NextToken })),
        )
      : [];
    const root = mappings.find((m) => !m.ApiMappingKey);
    if (root && root.ApiId !== apiId) throw new Error(`${spec.domain} already maps to another API (${root.ApiId}); remove that mapping first`);
    if (!domain) {
      domain = await deps.apigateway.send(new CreateDomainNameCommand({ DomainName: spec.domain, DomainNameConfigurations: configuration as never, ...(deps.tags ? { Tags: deps.tags(spec.domain) } : {}) }));
      outputs.domain_created = "true";
    } else if (domain.DomainNameConfigurations?.[0]?.CertificateArn !== certificate.outputs.arn) {
      domain = await deps.apigateway.send(new UpdateDomainNameCommand({ DomainName: spec.domain, DomainNameConfigurations: configuration as never }));
    }
    outputs.domain_name = domain.DomainNameConfigurations[0].ApiGatewayDomainName;
    outputs.url = `https://${spec.domain}`;
    if (!root) await deps.apigateway.send(new CreateApiMappingCommand({ DomainName: spec.domain, ApiId: apiId, Stage: STAGE }));

    deps.log(`pointing ${spec.domain} at ${outputs.domain_name}`);
    await dns.upsert({ name: spec.domain, type: "CNAME", values: [outputs.domain_name!], ttl: 300 });
    deps.log(`${spec.domain} serves ${spec.routes.length} route(s)`);
    return outputs;
  }

  return {
    async create(entry, context) {
      const outputs: Record<string, string> = {};
      try {
        return await converge(entry, context, outputs);
      } catch (err) {
        throw outputs.api_id ? new PartialApplyError(err, outputs) : err;
      }
    },

    async update(entry, current, _changes, context) {
      const outputs = { ...current.outputs };
      try {
        return await converge(entry, context, outputs, servedFunctions(current.spec));
      } catch (err) {
        throw new PartialApplyError(err, outputs);
      }
    },

    async delete(current) {
      const spec = current.spec as unknown as Partial<ApiComparable>;
      const domain = spec.domain ?? current.name;
      if (current.outputs.domain_name && spec.dns_provider && spec.dns_zone) {
        const dns = await deps.dns(spec.dns_provider, spec.dns_zone, spec.dns_token);
        const record = await dns.get(domain, "CNAME");
        if (record && sameTarget(record.values[0], current.outputs.domain_name)) await dns.remove(domain, "CNAME");
      }
      if (current.outputs.api_id) {
        const mappings = await all<{ ApiMappingId: string; ApiId: string }>((token) =>
          deps.apigateway.send(new GetApiMappingsCommand({ DomainName: domain, NextToken: token })).then((r: any) => ({ Items: r.Items, NextToken: r.NextToken })),
        ).catch((err) => (named(err, "NotFoundException") ? [] : Promise.reject(err)));
        for (const mapping of mappings.filter((m) => m.ApiId === current.outputs.api_id)) {
          await ignoreMissing(deps.apigateway.send(new DeleteApiMappingCommand({ DomainName: domain, ApiMappingId: mapping.ApiMappingId })));
        }
      }
      if (current.outputs.domain_created === "true") await ignoreMissing(deps.apigateway.send(new DeleteDomainNameCommand({ DomainName: domain })));
      if (current.outputs.api_id) await ignoreMissing(deps.apigateway.send(new DeleteApiCommand({ ApiId: current.outputs.api_id })));
      for (const fn of servedFunctions(current.spec)) await revoke(fn, domain);
    },
  };
}
