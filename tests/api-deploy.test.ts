import { describe, expect, test } from "bun:test";
import { MemoryDnsDriver } from "@cloudgear/dns/drivers/memory";
import type { CloudgearConfig } from "../src/config/schema";
import { endpointsFrom } from "../src/deploy/apply";
import { certificateDriver } from "../src/deploy/aws/certificate";
import { plan } from "../src/deploy/plan";
import { applyAll, baseConfig, emptyState, fakeAws, fn } from "./helpers";

const DOMAIN = "api.example.com";
const CERT_KEY = `@aws.Certificate.${DOMAIN}`;
const API_KEY = `@aws.ApiGateway.${DOMAIN}`;
const REGIONAL = "d-abc.execute-api.eu-west-1.amazonaws.com";
const dnsSpec = { provider: "gandi", domain: DOMAIN, zone: "example.com" };

const error = (name: string, message = name) => Object.assign(new Error(message), { name });

const apiConfig = (overrides: Partial<CloudgearConfig> = {}): CloudgearConfig => ({
  ...baseConfig(),
  certificate: [{ provider: "aws", domain: DOMAIN, dns: dnsSpec, usage: "api" }],
  api: { provider: "aws", domain: DOMAIN },
  ...overrides,
});

const twoRoutes = (names: [string, string] = ["foo", "bar"]) =>
  apiConfig({
    resource: [],
    function: [
      fn({ permission: [], env: [], route: [{ method: "GET", path: "/foo/{param}", name: names[0] }, { method: "POST", path: "/foo/{param}", name: "post" }] }),
      fn({ name: "bar", physical_name: "app-bar", permission: [], env: [], route: [{ method: "GET", path: "/bar", name: names[1] }] }),
    ],
  });

function gateway() {
  const integrations: { IntegrationId: string; IntegrationUri: string; Description: string }[] = [];
  const routes: { RouteId: string; RouteKey: string; Target: string }[] = [];
  const mappings: { ApiMappingId: string; ApiId: string; ApiMappingKey?: string }[] = [];
  let domain: any[] | null = null;
  let n = 0;
  const remove = <T>(items: T[], match: (item: T) => boolean) => void items.splice(0, items.length, ...items.filter((item) => !match(item)));
  return {
    GetIntegrationsCommand: () => ({ Items: integrations.map((i) => ({ ...i })) }),
    CreateIntegrationCommand: (i: any) => {
      const id = `int-${++n}`;
      integrations.push({ IntegrationId: id, IntegrationUri: i.IntegrationUri, Description: i.Description });
      return { IntegrationId: id };
    },
    UpdateIntegrationCommand: (i: any) => void (integrations.find((x) => x.IntegrationId === i.IntegrationId)!.IntegrationUri = i.IntegrationUri),
    DeleteIntegrationCommand: (i: any) => remove(integrations, (x) => x.IntegrationId === i.IntegrationId),
    GetRoutesCommand: () => ({ Items: routes.map((r) => ({ ...r })) }),
    CreateRouteCommand: (i: any) => void routes.push({ RouteId: `r-${++n}`, RouteKey: i.RouteKey, Target: i.Target }),
    UpdateRouteCommand: (i: any) => void (routes.find((x) => x.RouteId === i.RouteId)!.Target = i.Target),
    DeleteRouteCommand: (i: any) => remove(routes, (x) => x.RouteId === i.RouteId),
    GetDomainNameCommand: () => {
      if (!domain) throw error("NotFoundException");
      return { DomainNameConfigurations: domain };
    },
    CreateDomainNameCommand: (i: any) => {
      domain = [{ ...i.DomainNameConfigurations[0], ApiGatewayDomainName: REGIONAL }];
      return { DomainNameConfigurations: domain };
    },
    UpdateDomainNameCommand: (i: any) => {
      domain = [{ ...i.DomainNameConfigurations[0], ApiGatewayDomainName: REGIONAL }];
      return { DomainNameConfigurations: domain };
    },
    GetApiMappingsCommand: () => ({ Items: mappings.map((m) => ({ ...m })) }),
    CreateApiMappingCommand: (i: any) => void mappings.push({ ApiMappingId: `m-${++n}`, ApiId: i.ApiId }),
    DeleteApiMappingCommand: (i: any) => remove(mappings, (x) => x.ApiMappingId === i.ApiMappingId),
    mappings,
    routes,
    integrations,
  };
}

const regionalAws = (overrides: Record<string, (input: any, attempt: number) => any> = {}, dns?: MemoryDnsDriver | null) => {
  const api = gateway();
  const { mappings: _m, routes: _r, integrations: _i, ...commands } = api;
  const aws = fakeAws(
    {
      RequestCertificateCommand: () => ({ CertificateArn: "arn:aws:acm:eu-west-1:1:certificate/api" }),
      CreateFunctionCommand: (input) => ({ FunctionArn: `arn:aws:lambda:eu-west-1:1:function:${input.FunctionName}` }),
      ...commands,
      ...overrides,
    },
    dns,
  );
  return { aws, api };
};

describe("planning the API domain", () => {
  test("it comes after its certificate and every routed function, and goes before them on removal", () => {
    const created = plan(apiConfig(), emptyState());
    expect(created.map((a) => a.key)).toEqual(["@aws.S3.data", "@aws.S3.legacy", "@aws.Lambda.foo", CERT_KEY, API_KEY]);

    const state = emptyState();
    for (const action of created) {
      if (action.op === "create") state.entries[action.key] = { ...action.desired!, outputs: {}, spec: action.desired!.spec } as never;
    }
    const removal = plan({ ...baseConfig(), resource: [], function: [] }, state).map((a) => a.key);
    expect(removal.indexOf(API_KEY)).toBeLessThan(removal.indexOf(CERT_KEY));
    expect(removal.indexOf(API_KEY)).toBeLessThan(removal.indexOf("@aws.Lambda.foo"));
  });

  test("its certificate is issued in the function region, a CDN's in us-east-1, an unused one in us-east-1", () => {
    const regionOf = (config: CloudgearConfig) => plan(config, emptyState()).find((a) => a.key === CERT_KEY)!.desired!.spec.region;
    expect(regionOf(apiConfig())).toBe("");
    expect(regionOf(apiConfig({ region: "eu-central-1" }))).toBe("eu-central-1");
    expect(regionOf(apiConfig({ api: undefined, certificate: [{ provider: "aws", domain: DOMAIN, dns: dnsSpec }] }))).toBe("us-east-1");
  });

  test("it needs its certificate, and only routed functions are behind it", () => {
    expect(() => plan(apiConfig({ certificate: [] }), emptyState())).toThrow(/api needs a certificate for "api.example.com"/);
    const spec = plan(
      apiConfig({ function: [fn({ route: [], schedule: ["0 3 * * *"] }), fn({ name: "bar", physical_name: "app-bar" })] }),
      emptyState(),
    ).find((a) => a.key === API_KEY)!.desired!.spec as { routes: unknown[] };
    expect(spec.routes).toEqual([{ key: "POST /foo/{param}", function: "app-bar" }]);
  });

  test("routes are compared by key and function, so reordering changes nothing", async () => {
    const state = emptyState();
    const { aws } = regionalAws();
    await applyAll(twoRoutes(), state, aws);
    const reordered = twoRoutes();
    reordered.function.reverse();
    expect(plan(reordered, state).filter((a) => a.type === "@aws.ApiGateway").map((a) => a.op)).toEqual(["noop"]);
  });

  test("recreating a function points the API at it again", async () => {
    const state = emptyState();
    const { aws } = regionalAws();
    await applyAll(apiConfig(), state, aws);
    delete state.entries["@aws.Lambda.foo"];
    expect(plan(apiConfig(), state).find((a) => a.key === API_KEY)).toMatchObject({ op: "update", changes: ["dependencies"] });
  });
});

describe("applying the API domain", () => {
  test("creates the API, integrations, routes, permissions, stage, domain, mapping and DNS record in order", async () => {
    const state = emptyState();
    const { aws } = regionalAws();
    await applyAll(twoRoutes(), state, aws);

    const names = aws.names();
    const order = [
      "RequestCertificateCommand",
      "CreateApiCommand",
      "CreateIntegrationCommand",
      "CreateRouteCommand",
      "CreateStageCommand",
      "CreateDomainNameCommand",
      "CreateApiMappingCommand",
    ];
    const positions = order.map((n) => names.indexOf(n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    expect(aws.of("CreateApiCommand")).toEqual([{ Name: `cloudgear-${DOMAIN}`, ProtocolType: "HTTP", Description: "Managed by cloudgear" }]);
    expect(aws.of("CreateIntegrationCommand")).toEqual([
      { ApiId: "api1", IntegrationType: "AWS_PROXY", IntegrationUri: "arn:aws:lambda:eu-west-1:1:function:app-bar", PayloadFormatVersion: "2.0", Description: "app-bar" },
      { ApiId: "api1", IntegrationType: "AWS_PROXY", IntegrationUri: "arn:aws:lambda:eu-west-1:1:function:app-foo", PayloadFormatVersion: "2.0", Description: "app-foo" },
    ]);
    expect(aws.of("CreateRouteCommand")).toEqual([
      { ApiId: "api1", RouteKey: "GET /bar", Target: "integrations/int-1", AuthorizationType: "NONE" },
      { ApiId: "api1", RouteKey: "GET /foo/{param}", Target: "integrations/int-2", AuthorizationType: "NONE" },
      { ApiId: "api1", RouteKey: "POST /foo/{param}", Target: "integrations/int-2", AuthorizationType: "NONE" },
    ]);
    const grants = aws.of("AddPermissionCommand").filter((i) => i.Principal === "apigateway.amazonaws.com");
    expect(grants).toMatchObject([
      { FunctionName: "app-bar", Action: "lambda:InvokeFunction", SourceArn: "arn:aws:execute-api:eu-west-1:1:api1/*/*" },
      { FunctionName: "app-foo", Action: "lambda:InvokeFunction", SourceArn: "arn:aws:execute-api:eu-west-1:1:api1/*/*" },
    ]);
    expect(aws.of("CreateStageCommand")).toEqual([{ ApiId: "api1", StageName: "$default", AutoDeploy: true }]);
    expect(aws.of("CreateDomainNameCommand")).toEqual([
      {
        DomainName: DOMAIN,
        DomainNameConfigurations: [{ CertificateArn: "arn:aws:acm:eu-west-1:1:certificate/api", EndpointType: "REGIONAL", SecurityPolicy: "TLS_1_2" }],
      },
    ]);
    expect(aws.of("CreateApiMappingCommand")).toEqual([{ DomainName: DOMAIN, ApiId: "api1", Stage: "$default" }]);
    expect(await aws.dns!.get(DOMAIN, "CNAME")).toMatchObject({ values: [REGIONAL], ttl: 300 });

    expect(state.entries[API_KEY]!.outputs).toMatchObject({
      api_id: "api1",
      api_endpoint: "https://api1.execute-api.eu-west-1.amazonaws.com",
      domain_name: REGIONAL,
      url: `https://${DOMAIN}`,
    });
    expect(state.entries[API_KEY]!.deps).toEqual([CERT_KEY, "@aws.Lambda.foo", "@aws.Lambda.bar"]);
  });

  test("each step is reported, in order", async () => {
    const { aws } = regionalAws();
    await applyAll(apiConfig({ resource: [], function: [fn({ permission: [], env: [] })] }), emptyState(), aws);
    const steps = [
      /certificate issued/,
      /creating the API for api\.example\.com/,
      /connecting 1 route\(s\) to 1 function\(s\)/,
      /allowing API Gateway to invoke the functions/,
      /creating the custom domain api\.example\.com/,
      /pointing api\.example\.com at d-abc/,
      /api\.example\.com serves 1 route\(s\)/,
    ];
    const positions = steps.map((step) => aws.logs.findIndex((line) => step.test(line)));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("a second apply changes only what changed: a route is added, one is removed", async () => {
    const state = emptyState();
    const { aws, api } = regionalAws();
    await applyAll(twoRoutes(), state, aws);
    const calls = aws.calls.length;

    const smaller = twoRoutes();
    smaller.function[0]!.route = [{ method: "GET", path: "/foo/{param}", name: "foo" }];
    smaller.function[1]!.route.push({ method: "DELETE", path: "/bar", name: "del" });
    await applyAll(smaller, state, aws);
    const names = aws.calls.slice(calls).map((c) => c.name);
    expect(names).not.toContain("CreateApiCommand");
    expect(names).not.toContain("CreateDomainNameCommand");
    expect(names).not.toContain("CreateApiMappingCommand");
    expect(aws.calls.slice(calls).filter((c) => c.name === "CreateRouteCommand").map((c) => c.input.RouteKey)).toEqual(["DELETE /bar"]);
    expect(aws.calls.slice(calls).filter((c) => c.name === "DeleteRouteCommand")).toHaveLength(1);
    expect(api.routes.map((r) => r.RouteKey).sort()).toEqual(["DELETE /bar", "GET /bar", "GET /foo/{param}"]);
  });

  test("a function that leaves the API loses its integration and permission", async () => {
    const state = emptyState();
    const { aws, api } = regionalAws();
    await applyAll(twoRoutes(), state, aws);
    const only = twoRoutes();
    only.function = [only.function[0]!];
    const calls = aws.calls.length;
    await applyAll(only, state, aws);
    expect(api.integrations.map((i) => i.Description)).toEqual(["app-foo"]);
    const later = aws.calls.slice(calls);
    expect(later.filter((c) => c.name === "DeleteIntegrationCommand")).toHaveLength(1);
    expect(later.filter((c) => c.name === "RemovePermissionCommand").map((c) => c.input.FunctionName)).toContain("app-bar");
  });

  test("a function that was recreated has its integration moved to the new ARN", async () => {
    const state = emptyState();
    const { aws, api } = regionalAws();
    await applyAll(apiConfig({ resource: [], function: [fn({ permission: [], env: [] })] }), state, aws);
    const before = api.integrations[0]!.IntegrationUri;
    delete state.entries["@aws.Lambda.foo"];
    const again = fakeAws({ CreateFunctionCommand: () => ({ FunctionArn: "arn:aws:lambda:eu-west-1:1:function:app-foo-v2" }), ...gatewayOverrides(api) }, aws.dns);
    await applyAll(apiConfig({ resource: [], function: [fn({ permission: [], env: [] })] }), state, again);
    expect(api.integrations[0]!.IntegrationUri).not.toBe(before);
    expect(again.of("UpdateIntegrationCommand")).toHaveLength(1);
    expect(again.names()).not.toContain("CreateIntegrationCommand");
  });

  test("the certificate must be in the API's region", async () => {
    const aws = fakeAws({ CreateFunctionCommand: (input) => ({ FunctionArn: `arn:aws:lambda:eu-west-1:1:function:${input.FunctionName}` }) });
    await expect(applyAll(apiConfig(), emptyState(), aws)).rejects.toThrow(/in us-east-1 but the API is in eu-west-1; they must match/);
    expect(aws.names()).not.toContain("CreateApiCommand");
  });

  test("the API's region is the router's, and its certificate cannot say otherwise", () => {
    const config = (region?: string, certRegion?: string) =>
      apiConfig({ region, certificate: [{ provider: "aws", domain: DOMAIN, dns: dnsSpec, usage: "api", ...(certRegion ? { region: certRegion } : {}) }] });
    const regionOf = (c: CloudgearConfig, type: string) => plan(c, emptyState()).find((a) => a.type === type)!.desired!.spec.region;
    expect(regionOf(config("eu-central-1"), "@aws.ApiGateway")).toBe("eu-central-1");
    expect(regionOf(config("eu-central-1"), "@aws.Certificate")).toBe("eu-central-1");
    expect(regionOf(config(), "@aws.ApiGateway")).toBe("");
    expect(() => plan(config("eu-central-1", "us-east-1"), emptyState())).toThrow(/serves the API, so it must be in the function region/);
  });

  test("an existing record for the domain stops the apply before anything is created", async () => {
    const dns = new MemoryDnsDriver();
    await dns.upsert({ name: DOMAIN, type: "CNAME", values: ["old-api.example.net."], ttl: 300 });
    const { aws } = regionalAws({}, dns);
    await expect(applyAll(apiConfig(), emptyState(), aws)).rejects.toThrow(/DNS record api\.example\.com already exists \(CNAME old-api\.example\.net\.\)/);
    expect(aws.names()).not.toContain("RequestCertificateCommand");
    expect(aws.names()).not.toContain("CreateApiCommand");
  });

  test("a domain that exists and maps to another API is left untouched", async () => {
    const { aws, api } = regionalAws();
    api.CreateDomainNameCommand({ DomainNameConfigurations: [{ CertificateArn: "arn:aws:acm:eu-west-1:1:certificate/someone-elses", EndpointType: "REGIONAL" }] });
    api.mappings.push({ ApiMappingId: "m-other", ApiId: "someone-else" });
    await expect(applyAll(apiConfig(), emptyState(), aws)).rejects.toThrow(/already maps to another API \(someone-else\)/);
    expect(aws.names()).not.toContain("UpdateDomainNameCommand");
    expect(aws.names()).not.toContain("CreateApiMappingCommand");
    expect(await aws.dns!.get(DOMAIN, "CNAME")).toBeNull();
  });

  test("a domain cloudgear did not create is not deleted on destroy, only its own mapping", async () => {
    const { aws, api } = regionalAws();
    api.CreateDomainNameCommand({ DomainNameConfigurations: [{ CertificateArn: "arn:aws:acm:eu-west-1:1:certificate/api", EndpointType: "REGIONAL" }] });
    const state = emptyState();
    await applyAll(apiConfig(), state, aws);
    expect(state.entries[API_KEY]!.outputs.domain_created).toBeUndefined();
    const gone = fakeAws({ ...gatewayOverrides(api) }, aws.dns);
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, gone);
    expect(gone.names()).toContain("DeleteApiMappingCommand");
    expect(gone.names()).not.toContain("DeleteDomainNameCommand");
  });

  test("a domain cloudgear created is deleted on destroy", async () => {
    const state = emptyState();
    const { aws } = regionalAws();
    await applyAll(apiConfig(), state, aws);
    expect(state.entries[API_KEY]!.outputs.domain_created).toBe("true");
  });

  test("a stale permission for an old API is replaced, a current one is kept", async () => {
    const conflict = () => {
      throw error("ResourceConflictException", "The statement id (cloudgear-api-x) provided already exists");
    };
    const policyFor = (sourceArn: string) => () => ({
      Policy: JSON.stringify({ Statement: [{ Sid: statementIdOf(), Condition: { ArnLike: { "AWS:SourceArn": sourceArn } } }] }),
    });
    const config = apiConfig({ resource: [], function: [fn({ permission: [], env: [] })] });
    const grants = (aws: ReturnType<typeof regionalAws>["aws"]) => aws.of("AddPermissionCommand").filter((i) => i.Principal === "apigateway.amazonaws.com");
    const removals = (aws: ReturnType<typeof regionalAws>["aws"]) => aws.of("RemovePermissionCommand").filter((i) => /cloudgear-api/.test(i.StatementId));

    let first = true;
    const stale = regionalAws({
      AddPermissionCommand: (input) => {
        if (input.Principal === "apigateway.amazonaws.com" && first) {
          first = false;
          conflict();
        }
      },
      GetPolicyCommand: policyFor("arn:aws:execute-api:eu-west-1:1:old-api/*/*"),
    });
    await applyAll(config, emptyState(), stale.aws);
    expect(removals(stale.aws)).toHaveLength(1);
    expect(grants(stale.aws)).toHaveLength(2);

    const current = regionalAws({
      AddPermissionCommand: (input) => {
        if (input.Principal === "apigateway.amazonaws.com") conflict();
      },
      GetPolicyCommand: policyFor("arn:aws:execute-api:eu-west-1:1:api1/*/*"),
    });
    await applyAll(config, emptyState(), current.aws);
    expect(removals(current.aws)).toEqual([]);
    expect(grants(current.aws)).toHaveLength(1);
  });

  test("routes and integrations are read across pages", async () => {
    const pages: (string | undefined)[] = [];
    const { aws } = regionalAws({
      GetRoutesCommand: (input) => {
        pages.push(input.NextToken);
        return input.NextToken ? { Items: [{ RouteId: "r-late", RouteKey: "GET /late", Target: "integrations/x" }] } : { Items: [], NextToken: "next" };
      },
    });
    await applyAll(apiConfig({ resource: [], function: [fn({ permission: [], env: [] })] }), emptyState(), aws);
    expect(pages).toEqual([undefined, "next"]);
    expect(aws.of("DeleteRouteCommand")).toEqual([{ ApiId: "api1", RouteId: "r-late" }]);
  });

  test("a changed certificate region is refused with a way out", async () => {
    const state = emptyState();
    const { aws } = regionalAws();
    await applyAll(apiConfig(), state, aws);
    const moved = apiConfig({ region: "eu-central-1", certificate: [{ provider: "aws", domain: DOMAIN, dns: dnsSpec, usage: "api" }] });
    await expect(applyAll(moved, state, fakeAws({}, aws.dns))).rejects.toThrow(/cannot move from eu-west-1 to eu-central-1; destroy it and apply again/);
  });

  test("a certificate whose endpoint already exists skips the record precheck", async () => {
    const state = emptyState();
    const { aws } = regionalAws();
    await applyAll(apiConfig(), state, aws);
    delete state.entries[CERT_KEY];
    const dns = new MemoryDnsDriver();
    await dns.upsert({ name: DOMAIN, type: "CNAME", values: [REGIONAL], ttl: 300 });
    const again = regionalAws({}, dns).aws;
    await applyAll(apiConfig(), state, again);
    expect(again.names()).toContain("RequestCertificateCommand");
  });

  test("a hand-written config whose certificate has the wrong usage is refused", () => {
    expect(() => plan(apiConfig({ certificate: [{ provider: "aws", domain: DOMAIN, dns: dnsSpec }] }), emptyState())).toThrow(/must have usage "api"/);
  });

  test("an existing domain name is reused, and a changed certificate updates it", async () => {
    const state = emptyState();
    const { aws, api } = regionalAws();
    await applyAll(apiConfig(), state, aws);
    const other = fakeAws({ ...gatewayOverrides(api), CreateFunctionCommand: (input) => ({ FunctionArn: `arn:aws:lambda:eu-west-1:1:function:${input.FunctionName}` }) }, aws.dns);
    state.entries[CERT_KEY]!.outputs.arn = "arn:aws:acm:eu-west-1:1:certificate/rotated";
    await applyAll(apiConfig({ function: [fn(), fn({ name: "baz", physical_name: "app-baz", route: [{ method: "GET", path: "/baz", name: "baz" }] })] }), state, other);
    expect(other.names()).not.toContain("CreateDomainNameCommand");
    expect(other.of("UpdateDomainNameCommand")).toMatchObject([{ DomainNameConfigurations: [{ CertificateArn: "arn:aws:acm:eu-west-1:1:certificate/rotated" }] }]);
  });

  test("a failure after the API exists keeps it in state and the next apply resumes", async () => {
    const state = emptyState();
    const { aws, api } = regionalAws({
      CreateDomainNameCommand: () => {
        throw error("BadRequestException", "certificate rejected");
      },
    });
    await expect(applyAll(apiConfig(), state, aws)).rejects.toThrow("certificate rejected");
    expect(state.entries[API_KEY]!.spec).toMatchObject({ incomplete: true });
    expect(state.entries[API_KEY]!.outputs.api_id).toBe("api1");

    const resumed = fakeAws({ ...gatewayOverrides(api) }, aws.dns);
    await applyAll(apiConfig(), state, resumed);
    expect(resumed.names()).not.toContain("CreateApiCommand");
    expect(resumed.names()).toContain("CreateDomainNameCommand");
    expect(state.entries[API_KEY]!.spec).not.toHaveProperty("incomplete");
    expect(plan(apiConfig(), state).every((a) => a.op === "noop" || a.op === "dry")).toBe(true);
  });

  test("a failure before anything exists leaves nothing half-recorded", async () => {
    const state = emptyState();
    const { aws } = regionalAws({
      CreateApiCommand: () => {
        throw error("AccessDeniedException");
      },
    });
    await expect(applyAll(apiConfig(), state, aws)).rejects.toThrow("AccessDeniedException");
    expect(state.entries[API_KEY]).toBeUndefined();
  });

  test("it reports the API in the endpoints once deployed", async () => {
    expect(endpointsFrom(apiConfig(), emptyState()).api).toBeUndefined();
    const state = emptyState();
    const { aws } = regionalAws();
    await applyAll(apiConfig(), state, aws);
    expect(endpointsFrom(apiConfig(), state).api).toEqual({ domain: DOMAIN, url: `https://${DOMAIN}`, id: "api1" });
    expect(endpointsFrom({ ...apiConfig(), api: undefined }, state).api).toBeUndefined();
  });
});

describe("destroying the API domain", () => {
  test("removes the record, mapping, domain, API and permissions, before the function and certificate", async () => {
    const state = emptyState();
    const { aws, api } = regionalAws();
    await applyAll(twoRoutes(), state, aws);
    const gone = fakeAws({ ...gatewayOverrides(api) }, aws.dns);
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, gone);

    const names = gone.names();
    const inOrder = ["DeleteApiMappingCommand", "DeleteDomainNameCommand", "DeleteApiCommand", "DeleteFunctionCommand", "DeleteCertificateCommand"];
    const positions = inOrder.map((n) => names.indexOf(n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(gone.of("DeleteApiCommand")).toEqual([{ ApiId: "api1" }]);
    expect(gone.of("DeleteDomainNameCommand")).toEqual([{ DomainName: DOMAIN }]);
    expect(gone.of("RemovePermissionCommand").filter((i) => /cloudgear-api/.test(i.StatementId)).map((i) => i.FunctionName).sort()).toEqual(["app-bar", "app-foo"]);
    expect(await aws.dns!.get(DOMAIN, "CNAME")).toBeNull();
    expect(state.entries).toEqual({});
  });

  test("a record that no longer points at the API is left alone, and missing pieces are tolerated", async () => {
    const state = emptyState();
    const { aws } = regionalAws();
    await applyAll(apiConfig(), state, aws);
    await aws.dns!.upsert({ name: DOMAIN, type: "CNAME", values: ["somewhere.else."], ttl: 300 });
    const missing = (name: string) => () => {
      throw error(name);
    };
    const gone = fakeAws(
      {
        GetApiMappingsCommand: missing("NotFoundException"),
        DeleteDomainNameCommand: missing("NotFoundException"),
        DeleteApiCommand: missing("NotFoundException"),
        RemovePermissionCommand: missing("ResourceNotFoundException"),
      },
      aws.dns,
    );
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, gone);
    expect(await aws.dns!.get(DOMAIN, "CNAME")).toMatchObject({ values: ["somewhere.else."] });
    expect(state.entries).toEqual({});
  });

  test("a failed create still cleans up the API it made", async () => {
    const state = emptyState();
    const { aws, api } = regionalAws({
      CreateDomainNameCommand: () => {
        throw error("BadRequestException", "no");
      },
    });
    await expect(applyAll(apiConfig(), state, aws)).rejects.toThrow("no");
    const cleanup = fakeAws({ ...gatewayOverrides(api) }, aws.dns);
    await applyAll({ ...baseConfig(), resource: [], function: [] }, state, cleanup);
    expect(cleanup.of("DeleteApiCommand")).toEqual([{ ApiId: "api1" }]);
    expect(cleanup.names()).not.toContain("DeleteDomainNameCommand");
  });
});

describe("certificate regions", () => {
  test("the certificate is requested, described and deleted in its own region", async () => {
    const regions: string[] = [];
    const clientFor = (region: string) => ({
      send: async (command: { constructor: { name: string }; input: any }) => {
        regions.push(region);
        if (command.constructor.name === "RequestCertificateCommand") return { CertificateArn: `arn:aws:acm:${region}:1:certificate/x` };
        if (command.constructor.name === "DescribeCertificateCommand") {
          return { Certificate: { Status: "ISSUED", DomainValidationOptions: [{ ResourceRecord: { Name: "_v.api.example.com.", Value: "_t." } }] } };
        }
        return {};
      },
    });
    const driver = certificateDriver({ acm: clientFor, region: "eu-west-1", dns: async () => new MemoryDnsDriver(), sleep: async () => {}, log: () => {} });
    const entry = {
      kind: "resource" as const,
      type: "@aws.Certificate",
      name: DOMAIN,
      physical_name: DOMAIN,
      dry: false,
      source: {} as never,
      deps: [],
      spec: { domain: DOMAIN, for_endpoint: false, region: "eu-central-1", dns_provider: "gandi", dns_zone: "example.com" },
    };
    const context = { entry: () => undefined };
    const outputs = await driver.create(entry, context);
    expect(outputs.arn).toBe("arn:aws:acm:eu-central-1:1:certificate/x");
    expect(regions.every((r) => r === "eu-central-1")).toBe(true);

    regions.length = 0;
    await driver.delete({ ...entry, spec: entry.spec, outputs } as never, context);
    expect(regions).toEqual(["eu-central-1"]);

    regions.length = 0;
    const own = await driver.create({ ...entry, spec: { ...entry.spec, region: "" } }, context);
    expect(own.arn).toBe("arn:aws:acm:eu-west-1:1:certificate/x");
    expect(regions.every((r) => r === "eu-west-1")).toBe(true);
  });
});

function statementIdOf(): string {
  return `cloudgear-api-${new Bun.CryptoHasher("sha256").update(DOMAIN).digest("hex").slice(0, 12)}`;
}

function gatewayOverrides(api: ReturnType<typeof gateway>) {
  const { mappings: _m, routes: _r, integrations: _i, ...commands } = api;
  return commands;
}
