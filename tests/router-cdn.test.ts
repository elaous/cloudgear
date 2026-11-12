import { createHash } from "node:crypto";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BlobStore } from "@cloudgear/blob";
import { CDN, Cert } from "@cloudgear/cdn";
import { DNS } from "@cloudgear/dns";
import { FunctionRouter } from "@cloudgear/functions";
import { generate } from "../src/generate";
import type { CloudgearConfig } from "../src/config/schema";
import { decodeConfig, encodeConfig } from "../src/config/schema";
import { endpointsFrom } from "../src/deploy/apply";
import { routeFunctionCode } from "../src/deploy/aws/route-function";
import { plan, type CdnComparable } from "../src/deploy/plan";
import { behaviorsFor, conflictingGroups, groupRoutes, routeShape } from "../src/routes";
import { applyAll, baseConfig, emptyState, fakeAws, fn } from "./helpers";

setDefaultTimeout(30_000);

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", "router", name);

const DOMAIN = "api.example.com";
const CERT_KEY = `@aws.Certificate.${DOMAIN}`;
const CDN_KEY = `@aws.CloudFront.${DOMAIN}`;
const dnsSpec = { provider: "gandi", domain: DOMAIN, zone: "example.com" };

const items = fn({
  name: "items",
  physical_name: "app-items",
  route: [
    { method: "GET", path: "/items", name: "listItems" },
    { method: "POST", path: "/items", name: "createItems" },
  ],
});
const item = fn({ name: "item", physical_name: "app-item", route: [{ method: "GET", path: "/items/{id}", name: "getItem" }] });
const createItem = fn({ name: "createItem", physical_name: "app-createItem", route: [{ method: "POST", path: "/items", name: "createItem" }] });
const listItems = fn({ name: "listItems", physical_name: "app-listItems", route: [{ method: "GET", path: "/items", name: "listItems" }] });

const routerCdnConfig = (overrides: Partial<CloudgearConfig> = {}): CloudgearConfig => ({
  ...baseConfig(),
  function: [items, item],
  certificate: [{ provider: "aws", domain: DOMAIN, dns: dnsSpec, usage: "cdn" }],
  api: { provider: "aws", domain: DOMAIN, via: "cloudfront" },
  ...overrides,
});

const conflictConfig = (methodRouting: boolean): CloudgearConfig =>
  routerCdnConfig({ function: [listItems, createItem], api: { provider: "aws", domain: DOMAIN, via: "cloudfront", ...(methodRouting ? { method_routing: true } : {}) } });

describe("route grouping", () => {
  const routes = [
    { method: "GET", path: "/items/{id}", function: "item" },
    { method: "GET", path: "/items", function: "items" },
    { method: "POST", path: "/items/", function: "items" },
    { method: "GET", path: "/items/{id}/parts", function: "parts" },
  ];

  test("params become wildcards and the trailing slash is ignored when grouping", () => {
    expect(routeShape("/a/{x}/b/")).toBe("/a/{}/b");
    expect(routeShape("/")).toBe("/");
    expect(groupRoutes(routes).find((g) => g.pattern === "/items")).toMatchObject({ methods: ["GET", "POST"], functions: ["items"] });
  });

  test("behaviors go literal-heavy first, exact before wildcard, and cover the trailing slash", () => {
    expect(behaviorsFor(routes).map((b) => b.pattern)).toEqual(["/items/*/parts/", "/items/*/parts", "/items/", "/items/*", "/items"]);
    expect(behaviorsFor([{ method: "GET", path: "/", function: "root" }]).map((b) => b.pattern)).toEqual(["/"]);
  });

  test("a literal path hiding methods of the param path that covers it is a conflict", () => {
    const overlap = [
      { method: "POST", path: "/items/new", function: "fresh" },
      { method: "GET", path: "/items/{id}", function: "item" },
    ];
    expect(conflictingGroups(overlap)).toMatchObject([{ pattern: "/items/* and /items/new", methods: ["GET", "POST"], functions: ["fresh", "item"] }]);
    expect(conflictingGroups([...overlap, { method: "GET", path: "/items/new", function: "fresh" }])).toEqual([]);
    expect(conflictingGroups(overlap.map((r) => ({ ...r, function: "same" })))).toEqual([]);
    expect(conflictingGroups([{ method: "GET", path: "/items/new", function: "fresh" }, { method: "GET", path: "/items/{id}", function: "item" }])).toEqual([]);
  });
});

describe("planning a CDN that serves the router", () => {
  test("applies the certificate and the functions before the distribution", () => {
    const actions = plan(routerCdnConfig(), emptyState());
    expect(actions.map((a) => a.key)).toEqual(["@aws.S3.data", "@aws.S3.legacy", "@aws.Lambda.items", "@aws.Lambda.item", CERT_KEY, CDN_KEY]);
    expect(actions.find((a) => a.key === CDN_KEY)!.desired!.deps).toEqual([CERT_KEY, "@aws.Lambda.items", "@aws.Lambda.item"]);
  });

  test("one behavior per path, each to its one function", () => {
    const spec = plan(routerCdnConfig(), emptyState()).find((a) => a.key === CDN_KEY)!.desired!.spec as unknown as CdnComparable;
    expect(spec.bucket).toBe("");
    expect(spec.behaviors).toEqual([
      { pattern: "/items/", methods: ["GET", "POST"], function: "app-items" },
      { pattern: "/items/*", methods: ["GET"], function: "app-item" },
      { pattern: "/items", methods: ["GET", "POST"], function: "app-items" },
    ]);
    expect(spec.method_routes).toBeUndefined();
  });

  test("paths reaching different functions are refused unless method routing is on", () => {
    expect(() => plan(conflictConfig(false), emptyState())).toThrow(/CloudFront cannot tell apart/);
    const spec = plan(conflictConfig(true), emptyState()).find((a) => a.key === CDN_KEY)!.desired!.spec as unknown as CdnComparable;
    expect(spec.behaviors).toBeUndefined();
    expect(spec.method_routes).toEqual([
      { method: "GET", path: "/items", function: "app-listItems" },
      { method: "POST", path: "/items", function: "app-createItem" },
    ]);
  });

  test("the certificate must be in us-east-1", () => {
    const config = routerCdnConfig({ certificate: [{ provider: "aws", domain: DOMAIN, dns: dnsSpec, usage: "cdn", region: "eu-west-1" }] });
    expect(() => plan(config, emptyState())).toThrow(/must be in us-east-1/);
  });

  test("a route change updates the distribution and nothing else", async () => {
    const state = emptyState();
    await applyAll(routerCdnConfig(), state);
    expect(plan(routerCdnConfig(), state).filter((a) => a.op !== "noop" && a.op !== "dry")).toEqual([]);
    const changed = routerCdnConfig({ function: [items, { ...item, route: [{ method: "GET", path: "/things/{id}", name: "getItem" }] }] });
    const actions = plan(changed, state).filter((a) => a.op !== "noop" && a.op !== "dry");
    expect(actions.map((a) => [a.key, a.op])).toEqual([[CDN_KEY, "update"]]);
  });
});

describe("applying a CDN that serves the router", () => {
  test("creates a Lambda origin access control, function origins and behaviors, and no bucket access", async () => {
    const state = emptyState();
    const aws = await applyAll(routerCdnConfig(), state);

    expect(aws.of("CreateOriginAccessControlCommand").map((i) => i.OriginAccessControlConfig)).toMatchObject([
      { Name: `cloudgear-${DOMAIN}-lambda`, OriginAccessControlOriginType: "lambda", SigningBehavior: "always", SigningProtocol: "sigv4" },
    ]);
    const config = aws.of("CreateDistributionCommand")[0].DistributionConfig;
    expect(config.DefaultRootObject).toBe("");
    expect(config.Origins.Items.map((o: any) => o.Id)).toEqual(["cloudgear-fn-app-item", "cloudgear-fn-app-items"]);
    expect(config.Origins.Items[0]).toMatchObject({
      DomainName: "app-item.lambda-url.eu-west-1.on.aws",
      OriginAccessControlId: "oac-lambda",
      CustomOriginConfig: { OriginProtocolPolicy: "https-only" },
    });
    const all = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"];
    expect(config.CacheBehaviors.Items.map((b: any) => [b.PathPattern, b.TargetOriginId, b.AllowedMethods.Items])).toEqual([
      ["/items/", "cloudgear-fn-app-items", all],
      ["/items/*", "cloudgear-fn-app-item", ["GET", "HEAD"]],
      ["/items", "cloudgear-fn-app-items", all],
    ]);
    expect(config.CacheBehaviors.Items.map((b: any) => [b.PathPattern, b.ViewerProtocolPolicy])).toEqual([["/items/", "https-only"], ["/items/*", "redirect-to-https"], ["/items", "https-only"]]);
    expect(config.CacheBehaviors.Items.every((b: any) => b.Compress === true)).toBe(true);
    expect(config.DefaultCacheBehavior.ViewerProtocolPolicy).toBe("https-only");
    expect(config.DefaultCacheBehavior).toMatchObject({ TargetOriginId: "cloudgear-fn-app-item", CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" });
    expect(config.DefaultCacheBehavior.FunctionAssociations).toEqual({ Quantity: 0 });

    expect(aws.names()).not.toContain("PutBucketPolicyCommand");
    expect(state.entries[CDN_KEY]!.outputs).toMatchObject({ id: "E1", oac_lambda: "oac-lambda", status: "Deployed" });
    expect(state.entries[CDN_KEY]!.outputs.oac_s3).toBeUndefined();
  });

  test("allows only this distribution to call each function, over its URL", async () => {
    const aws = await applyAll(routerCdnConfig(), emptyState());
    const grants = aws.of("AddPermissionCommand").filter((i) => i.Principal === "cloudfront.amazonaws.com");
    expect(grants).toHaveLength(4);
    expect(grants.map((g) => [g.FunctionName, g.Action]).sort()).toEqual([
      ["app-item", "lambda:InvokeFunction"],
      ["app-item", "lambda:InvokeFunctionUrl"],
      ["app-items", "lambda:InvokeFunction"],
      ["app-items", "lambda:InvokeFunctionUrl"],
    ]);
    expect(grants.every((g) => g.SourceArn === "arn:aws:cloudfront::1:distribution/E1")).toBe(true);
  });

  test("points the domain at the distribution and reports it as the API endpoint", async () => {
    const state = emptyState();
    const config = routerCdnConfig();
    const aws = await applyAll(config, state);
    expect(await aws.dns!.get(DOMAIN, "CNAME")).toMatchObject({ values: ["d111.cloudfront.net"] });
    expect(endpointsFrom(config, state).api).toEqual({ domain: DOMAIN, url: "https://d111.cloudfront.net", id: "E1" });
  });

  test("method routing publishes a CloudFront Function and attaches it to the default behavior", async () => {
    const state = emptyState();
    const aws = await applyAll(conflictConfig(true), state);
    const created = aws.of("CreateFunctionCommand").find((i) => i.Name);
    expect(created).toMatchObject({ FunctionConfig: { Runtime: "cloudfront-js-2.0" } });
    expect(aws.names().indexOf("PublishFunctionCommand")).toBeLessThan(aws.names().indexOf("CreateDistributionCommand"));
    const config = aws.of("CreateDistributionCommand")[0].DistributionConfig;
    expect(config.CacheBehaviors).toEqual({ Quantity: 0, Items: [] });
    expect(config.DefaultCacheBehavior.FunctionAssociations).toEqual({
      Quantity: 1,
      Items: [{ EventType: "viewer-request", FunctionARN: expect.stringMatching(/^arn:aws:cloudfront::1:function\/cloudgear-/) }],
    });
    expect(state.entries[CDN_KEY]!.outputs.route_function).toMatch(/^cloudgear-.*-routes$/);
  });

  test("turning method routing off removes the function after the distribution stops using it", async () => {
    const state = emptyState();
    await applyAll(conflictConfig(true), state);
    const merged = routerCdnConfig({ function: [{ ...listItems, route: [...listItems.route] }, { ...createItem, route: [{ method: "POST", path: "/create", name: "createItem" }] }] });
    const aws = await applyAll(merged, state);
    const names = aws.names();
    expect(names.indexOf("UpdateDistributionCommand")).toBeLessThan(names.lastIndexOf("DeleteFunctionCommand"));
    expect(aws.of("DeleteFunctionCommand").some((i) => i.Name)).toBe(true);
    expect(state.entries[CDN_KEY]!.outputs.route_function).toBe("");
  });

  test("a function that stops being routed loses its permission and, with the last one, the access control", async () => {
    const state = emptyState();
    await applyAll(routerCdnConfig(), state);
    const aws = await applyAll(routerCdnConfig({ function: [items] }), state);
    expect(aws.of("RemovePermissionCommand").filter((i) => /^cloudgear-cdn-/.test(i.StatementId)).map((i) => i.FunctionName)).toEqual(["app-item", "app-item"]);
    expect(aws.of("DeleteOriginAccessControlCommand")).toEqual([]);
  });

  test("a permission left by an earlier distribution is replaced, one for this distribution is kept", async () => {
    const conflict = () => Object.assign(new Error("The statement id (cloudgear-cdn) provided already exists."), { name: "ResourceConflictException" });
    const run = async (sourceArn: string) => {
      const added = new Set<string>();
      return applyAll(
        routerCdnConfig({ function: [items] }),
        emptyState(),
        fakeAws({
          AddPermissionCommand: (input) => {
            if (input.Principal !== "cloudfront.amazonaws.com" || added.has(input.StatementId)) return {};
            added.add(input.StatementId);
            throw conflict();
          },
          GetPolicyCommand: () => ({
            Policy: JSON.stringify({
              Statement: ["url", "invoke"].map((kind) => ({
                Sid: `cloudgear-cdn-${createHash("sha256").update(DOMAIN).digest("hex").slice(0, 12)}-${kind}`,
                Condition: { ArnLike: { "AWS:SourceArn": sourceArn } },
              })),
            }),
          }),
        }),
      );
    };
    const stale = await run("arn:aws:cloudfront::1:distribution/OLD");
    expect(stale.of("RemovePermissionCommand")).toHaveLength(2);
    expect(stale.of("AddPermissionCommand").filter((i) => i.Principal === "cloudfront.amazonaws.com")).toHaveLength(4);
    const current = await run("arn:aws:cloudfront::1:distribution/E1");
    expect(current.of("RemovePermissionCommand")).toEqual([]);
    expect(current.of("AddPermissionCommand").filter((i) => i.Principal === "cloudfront.amazonaws.com")).toHaveLength(2);
  });

  test("a failed publish still records the routing function for cleanup", async () => {
    const state = emptyState();
    await expect(applyAll(conflictConfig(true), state, fakeAws({ PublishFunctionCommand: () => { throw new Error("publish failed"); } }))).rejects.toThrow("publish failed");
    expect(state.entries[CDN_KEY]!.outputs.route_function).toMatch(/^cloudgear-.*-routes$/);
  });

  test("a routing table beyond the CloudFront Function size limit is refused", async () => {
    const many = (method: string, name: string) =>
      fn({ name, physical_name: `app-${name}`, route: Array.from({ length: 300 }, (_, i) => ({ method, path: `/resource-number-${i}/{id}`, name: `${name}${i}` })) });
    const config = routerCdnConfig({ function: [many("GET", "reader"), many("POST", "writer")], api: { provider: "aws", domain: DOMAIN, via: "cloudfront", method_routing: true } });
    await expect(applyAll(config, emptyState())).rejects.toThrow(/allow 10240/);
  });

  test("destroying removes the distribution, the routing function, the access control and the permissions", async () => {
    const state = emptyState();
    await applyAll(conflictConfig(true), state);
    const aws = await applyAll({ ...baseConfig(), resource: [], function: [] }, state);
    const names = aws.names();
    expect(names).toContain("DeleteDistributionCommand");
    expect(names.indexOf("DeleteDistributionCommand")).toBeLessThan(names.indexOf("DeleteOriginAccessControlCommand"));
    expect(aws.of("DeleteFunctionCommand").some((i) => i.Name)).toBe(true);
    expect(aws.of("RemovePermissionCommand").filter((i) => /^cloudgear-cdn-/.test(i.StatementId)).length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(state.entries)).toEqual([]);
  });
});

describe("the routing function", () => {
  const compile = (routes: { method: string; path: string; function: string }[]) => {
    const selected: string[] = [];
    const source = routeFunctionCode(routes).replace("import cf from 'cloudfront';", "const cf = { selectRequestOriginById: (id) => selected.push(id) };");
    const handler = new Function("selected", `${source}\nreturn handler;`)(selected) as (event: unknown) => any;
    return { selected, run: (method: string, uri: string) => handler({ request: { method, uri } }) };
  };

  test("a HEAD request goes to the GET route unless the path has a HEAD route", () => {
    const { selected, run } = compile([
      { method: "GET", path: "/items", function: "list" },
      { method: "GET", path: "/files", function: "files" },
      { method: "HEAD", path: "/files", function: "headFiles" },
    ]);
    run("HEAD", "/items");
    run("HEAD", "/files");
    expect(selected).toEqual(["cloudgear-fn-list", "cloudgear-fn-headFiles"]);
    expect(run("HEAD", "/other")).toMatchObject({ statusCode: 404 });
  });

  test("selects the origin of the function for each method and path", () => {
    const { selected, run } = compile([
      { method: "GET", path: "/items", function: "list" },
      { method: "POST", path: "/items", function: "create" },
      { method: "GET", path: "/items/{id}", function: "get" },
      { method: "GET", path: "/items/new", function: "fresh" },
    ]);
    run("GET", "/items");
    run("POST", "/items/");
    run("GET", "/items/42");
    run("GET", "/items/new");
    expect(selected).toEqual(["cloudgear-fn-list", "cloudgear-fn-create", "cloudgear-fn-get", "cloudgear-fn-fresh"]);
  });

  test("answers 404 for an unknown method or path", () => {
    const { selected, run } = compile([{ method: "GET", path: "/items/{id}", function: "get" }]);
    expect(run("DELETE", "/items/1")).toMatchObject({ statusCode: 404 });
    expect(run("GET", "/items/1/parts")).toMatchObject({ statusCode: 404 });
    expect(run("GET", "/other")).toMatchObject({ statusCode: 404 });
    expect(selected).toEqual([]);
  });

  test("escapes literal characters in paths", () => {
    const { selected, run } = compile([{ method: "GET", path: "/v1.0/items", function: "get" }]);
    expect(run("GET", "/v1x0/items")).toMatchObject({ statusCode: 404 });
    run("GET", "/v1.0/items");
    expect(selected).toEqual(["cloudgear-fn-get"]);
  });
});

describe("the config file", () => {
  test("keeps the CDN settings of a router distribution through the prototxt", () => {
    const config = routerCdnConfig({ api: { provider: "aws", domain: DOMAIN, via: "cloudfront", method_routing: true, options: { price_class: "PriceClass_100" } } });
    expect(decodeConfig(encodeConfig(config)).api).toEqual(config.api);
    const gateway = routerCdnConfig({ api: { provider: "aws", domain: DOMAIN } });
    expect(decodeConfig(encodeConfig(gateway)).api).toEqual(gateway.api);
  });

  test("a bad CDN option is rejected for the router distribution too", () => {
    const config = routerCdnConfig({ api: { provider: "aws", domain: DOMAIN, via: "cloudfront", options: { price_class: "nope" } } });
    expect(() => plan(config, emptyState())).toThrow(/price_class/);
  });
});

describe("generating for a CDN that serves the router", () => {
  test("writes the API as a CloudFront one, and functions verify callers themselves", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-router-cdn-"));
    try {
      const { config } = await generate({ entry: fixture("edge/cdn-router.ts"), configPath: path.join(dir, "cloudgear.prototxt"), buildDir: path.join(dir, "build") });
      expect(config.api).toEqual({ provider: "aws", domain: DOMAIN, via: "cloudfront" });
      expect(config.certificate).toMatchObject([{ domain: DOMAIN, usage: "cdn" }]);
      expect(config.cdn).toEqual([]);
      expect(fs.readFileSync(path.join(dir, "build", "items", "entry.ts"), "utf8")).toContain("trustContext: false");
      const spec = plan(config, emptyState()).find((a) => a.key === CDN_KEY)!.desired!.spec as unknown as CdnComparable;
      expect(spec.behaviors!.map((b) => b.pattern)).toEqual(["/items/", "/items/*", "/items"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to write a config for routes CloudFront cannot tell apart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-router-conflict-"));
    try {
      await expect(generate({ entry: fixture("edge/cdn-router-conflict.ts"), configPath: path.join(dir, "cloudgear.prototxt"), buildDir: path.join(dir, "build") })).rejects.toThrow(/Choose one/);
      expect(fs.existsSync(path.join(dir, "cloudgear.prototxt"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CDN and FunctionRouter at runtime", () => {
  const dns = new DNS("gandi", DOMAIN, { zone: "example.com" });
  const cert = new Cert("aws", dns);

  test("a CDN serves a bucket or a router, not both or neither", () => {
    const router = new FunctionRouter("aws");
    expect(new CDN("aws", cert, { router }).domain).toBe(DOMAIN);
    expect(() => new CDN("aws", cert, {})).toThrow(/exactly one of `bucket` and `router`/);
    expect(() => new CDN("aws", cert, { router, bucket: new BlobStore("aws", "://site") })).toThrow(/exactly one of `bucket` and `router`/);
    expect(() => new CDN("aws", cert, { bucket: new BlobStore("aws", "://site"), methodRouting: "function" })).toThrow(/only applies to a CDN that serves a router/);
  });

  test("route URLs use the CDN's domain from the endpoints file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudgear-endpoints-"));
    try {
      const file = path.join(dir, "endpoints.json");
      fs.writeFileSync(file, JSON.stringify({ provider: "aws", routes: { "GET /items": "https://fn.lambda-url.on.aws" }, api: { domain: DOMAIN, url: "https://d1.cloudfront.net" } }));
      const router = new FunctionRouter("aws", { mode: "remote", endpointsFile: file }).url("GET", "/items", async () => ({}), { name: "items" });
      expect(router.urls()).toEqual({ items: `https://${DOMAIN}/items` });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
