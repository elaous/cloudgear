import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { debug, errorSummary, timed } from "@cloudgear/debug";
import {
  INVOKE_CONTENT_TYPE,
  ROUTE_HEADER,
  PARAM,
  assertMethod,
  buildInput,
  compilePath,
  invoke,
  matchPath,
  parseBody,
  type response,
  routeKey,
  serializeRequest,
  vercelRequestFrom,
  type Handler,
  type OriginalRequest,
  type ResponseKind,
  type RequestContext,
  type Method,
  type PathParams,
  type Provider,
} from "./http";
import type { Authenticator } from "./auth";
import { VercelResponse } from "./vercel";
import type { ScheduleSpec } from "./cron";
import { signFunctionUrlRequest, type AwsCredentialsProvider } from "./sign";

export type ProviderOptions = Record<string, string | number | boolean>;

export type Authentication = "iam" | "none";
export type EndpointAuth = Authentication;

// Shape-typed values from @cloudgear/secrets and @cloudgear/events.
export type EnvOption = { readonly kind: "env"; readonly prefix: string; readonly names: object } | { readonly prefix: string; readonly all: true };
export type EventOption = { readonly kind: "event"; readonly type: string };
export type PolicyOption = { readonly kind: "policy"; readonly name: string };

export interface RouteOptions {
  name?: string;
  public?: boolean;
  // Literals only; read by generate.
  options?: ProviderOptions;
  // Project-root paths, packaged with the function; literals only.
  include?: string | string[];
  request?: boolean;
  // Second argument: `response` helper or `VercelResponse` writer.
  response?: typeof response | typeof VercelResponse;
  schedule?: ScheduleSpec | ScheduleSpec[];
  on?: EventOption | EventOption[];
  // Secrets for the environment; read inline only.
  env?: EnvOption | EnvOption[];
  // Inline IAM policies put on the function's role (see @cloudgear/iam): `policies: [readBucket]`.
  policies?: PolicyOption | PolicyOption[];
}

export type FetchBody = string | Uint8Array | ArrayBuffer | URLSearchParams | Record<string, unknown> | unknown[];

export interface FetchOpts {
  // Defaults to the route's own method.
  method?: Method | Lowercase<Method>;
  headers?: Record<string, string> | Headers;
  // Objects and arrays are sent as JSON.
  body?: FetchBody;
  query?: Record<string, string | number | boolean> | URLSearchParams | string;
  // Fills {placeholders} in the route's path; "." and ".." are refused.
  params?: Record<string, string | number>;
}

export interface RouterFetch {
  // Second argument ignored; Bun.serve passes its server.
  (req: Request, server?: unknown): Promise<Response>;
  (input: string | URL, init?: RequestInit): Promise<Response>;
  (name: string, opts?: FetchOpts): Promise<Response>;
}

export interface EndpointsFile {
  provider: string;
  routes: Record<string, string>;
  auth?: EndpointAuth;
  cdn?: { domain: string; url: string; id?: string };
  cdns?: Record<string, { domain: string; url: string; id?: string }>;
  api?: { domain: string; url: string; id?: string; via?: "cloudfront" };
}

export interface RateLimit {
  limit: number;
  windowMs: number;
  // Required unless `trustProxy` is set.
  key?: (req: Request) => string;
  // Enable only behind a proxy that overwrites X-Forwarded-For.
  trustProxy?: boolean;
}

export interface FunctionRouterOptions {
  mode?: "local" | "remote";
  endpoints?: Record<string, string>;
  endpointsFile?: string;
  // Literal only: generate reads it; defaults to "iam".
  authenticated?: Authentication;
  credentials?: AwsCredentialsProvider;
  // Literal only: generate reads it; defaults to --region or AWS_REGION.
  region?: string;
  // Return null for 401; `public` routes skip it.
  authenticate?: Authenticator;
  // Also serves Cert's domain routes via API Gateway; skips `authenticate`.
  cert?: { readonly domain: string };
  // Literals only; read by generate.
  functionOptions?: ProviderOptions;
  // Tolerated unset variables; literal names, not required by generate.
  optionalEnv?: string[];
  env?: EnvOption | EnvOption[];
  // Policies every function gets (see RouteOptions.policies).
  policies?: PolicyOption | PolicyOption[];
  // Per-process; serverless instances do not share counters.
  rateLimit?: RateLimit;
}

interface CompiledRoute {
  method: Method;
  path: string;
  key: string;
  name: string;
  public: boolean;
  matcher: ReturnType<typeof compilePath>;
  fn?: (...args: any[]) => unknown;
  request: boolean;
  response?: ResponseKind;
  script?: string;
}

interface Endpoints {
  routes: Record<string, string>;
  auth?: EndpointAuth;
  api?: { domain: string; url?: string; via?: "cloudfront" };
}

type Target = { kind: "local" | "api" | "cdn" | "function"; base: string };

const SCHEME_URL = /^[a-z][a-z\d+.-]*:\/\//i;
const ABSOLUTE_INPUT = /^(?:[a-z][a-z\d+.-]*:\/\/|\/\/|\\\\)/i;
const CLOUDFRONT_HOST = /\.cloudfront\.net$/i;
const PLACEHOLDER_ORIGIN = "http://router.invalid";

export const DEFAULT_ENDPOINTS_FILE = ".cloudgear/endpoints.json";
// Oldest counters dropped past this to bound memory.
const MAX_TRACKED_CLIENTS = 10_000;

export class FunctionRouter {
  private readonly routes: CompiledRoute[] = [];
  private readonly windows = new Map<string, { start: number; count: number }>();
  private endpoints: Endpoints | null | undefined;
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor(
    readonly provider: Provider,
    private readonly options: FunctionRouterOptions = {},
  ) {
    const limit = options.rateLimit;
    if (limit && !limit.key && !limit.trustProxy) {
      throw new Error("rateLimit needs a key(req) function, or trustProxy: true to use X-Forwarded-For");
    }
  }

  url<P extends string>(method: Method | Lowercase<Method>, path: P, script: string, options?: RouteOptions): this;
  url<P extends string>(
    method: Method | Lowercase<Method>,
    path: P,
    fn: (...args: any[]) => unknown,
    options: RouteOptions & ({ request: true } | { response: typeof response | typeof VercelResponse }),
  ): this;
  url<P extends string, I extends { readonly [K in PathParams<P>]: unknown }, O>(
    method: Method | Lowercase<Method>,
    path: P,
    fn: Handler<I, O>,
    options?: RouteOptions,
  ): this;
  url(method: Method | Lowercase<Method>, path: string, handler: ((...args: any[]) => unknown) | string, options: RouteOptions = {}): this {
    const route = { method: assertMethod(method), path };
    const key = routeKey(route);
    if (this.routes.some((r) => r.key === key)) throw new Error(`Route "${key}" is already registered`);
    const script = typeof handler === "string" ? scriptPath(handler) : undefined;
    const fn = typeof handler === "string" ? undefined : handler;
    const name = options.name ?? (fn?.name || key);
    if (!name) throw new Error(`Route "${key}": name must not be empty`);
    if (name.startsWith("/") || name.startsWith("\\") || SCHEME_URL.test(name)) {
      throw new Error(`Route "${key}": name "${name}" must not start with "/" or "\\" or look like a URL; fetch would read it as a path`);
    }
    if (this.routes.some((r) => r.name === name)) {
      throw new Error(`Route name "${name}" is already used; pass { name } to tell routes apart`);
    }
    this.routes.push({ ...route, key, name, public: options.public ?? false, matcher: compilePath(path), fn, script, request: options.request === true, response: options.response === VercelResponse ? "writer" : options.response ? "helper" : undefined });
    return this;
  }

  get mode(): "local" | "remote" {
    if (this.options.mode) return this.options.mode;
    return this.loadEndpoints() ? "remote" : "local";
  }

  fetch: RouterFetch = ((target: Request | string | URL, second?: FetchOpts | RequestInit) => {
    if (target instanceof Request) return this.handle(target);
    if (target instanceof URL || (typeof target === "string" && (target.startsWith("/") || target.startsWith("\\") || SCHEME_URL.test(target)))) {
      return this.fetchPath(target, second as RequestInit | undefined);
    }
    if (typeof target === "string") return this.fetchRoute(target, second as FetchOpts | undefined);
    throw new TypeError("fetch takes a Request, a path or a route name");
  }) as RouterFetch;

  urlFrom(name: string, params: Record<string, string | number> = {}): URL {
    const route = this.routes.find((r) => r.name === name);
    if (!route) throw new Error(`No route named "${name}"; known routes: ${this.routes.map((r) => r.name).join(", ") || "none"}`);
    const template = this.urls()[name];
    if (!template) throw new Error(`Route "${name}" has no URL yet; deploy it or call listen() first`);
    const unused = new Set(Object.keys(params));
    const filled = template.replace(new RegExp(PARAM.source, "g"), (_, key: string) => {
      if (!(key in params)) throw new Error(`Route "${name}" needs the path parameter "${key}"`);
      unused.delete(key);
      const value = String(params[key]);
      if (value === "." || value === "..") throw new Error(`Path parameter "${key}" of route "${name}" cannot be "${value}"`);
      return encodeURIComponent(value);
    });
    if (unused.size) throw new Error(`Route "${name}" has no path parameter ${[...unused].map((k) => `"${k}"`).join(", ")}`);
    return new URL(filled);
  }

  private async fetchRoute(name: string, opts: FetchOpts = {}): Promise<Response> {
    const url = this.urlFrom(name, opts.params);
    const method = assertMethod((opts.method ?? this.routes.find((r) => r.name === name)!.method).toUpperCase());
    if (opts.query !== undefined) {
      const query = opts.query instanceof URLSearchParams || typeof opts.query === "string" ? new URLSearchParams(opts.query) : new URLSearchParams(Object.entries(opts.query).map(([k, v]): [string, string] => [k, String(v)]));
      for (const [key, value] of query) url.searchParams.append(key, value);
    }
    const headers = new Headers(opts.headers);
    let body: Uint8Array | string | undefined;
    if (opts.body !== undefined) {
      if (method === "GET" || method === "HEAD") throw new Error(`A ${method} request cannot have a body`);
      const given = opts.body;
      if (typeof given === "string") body = given;
      else if (given instanceof Uint8Array) body = given;
      else if (given instanceof ArrayBuffer) body = new Uint8Array(given);
      else if (given instanceof URLSearchParams) {
        body = given.toString();
        if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded");
      } else if (Array.isArray(given) || Object.getPrototypeOf(given) === Object.prototype || Object.getPrototypeOf(given) === null) {
        body = JSON.stringify(given);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      } else {
        throw new TypeError("fetch body must be a string, bytes, URLSearchParams, a plain object or an array");
      }
    }
    // CloudFront origin access control needs the payload hash on writes.
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      headers.set("x-amz-content-sha256", createHash("sha256").update(body ?? "").digest("hex"));
    }
    debug("router", `fetch ${method} ${name}`);
    return fetch(url, { method, headers, body, redirect: "manual" });
  }

  private async fetchPath(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const parsed = this.parseClientPath(input);
    const { route, method } = this.pickRoute(parsed.pathname, init.method);
    const target = this.resolver()(route);
    if (!target) throw new Error(`Route "${route.name}" has no URL yet; deploy it or call listen() first`);
    if ((method === "GET" || method === "HEAD") && init.body !== undefined && init.body !== null) throw new Error(`A ${method} request cannot have a body`);
    const original = new Request(`${PLACEHOLDER_ORIGIN}${parsed.pathname}${parsed.search}`, { ...init, method });
    debug("router", `fetch ${method} ${route.key} via ${target.kind}`);
    if (target.kind === "function") return this.fetchFunctionUrl(route, this.loadEndpoints()!.routes[route.key]!, parsed, original, init);
    const headers = new Headers(original.headers);
    const bytes = new Uint8Array(await original.arrayBuffer());
    const hasBody = bytes.length > 0 || method === "POST" || method === "PUT" || method === "PATCH";
    if (target.kind === "cdn" && hasBody && !headers.has("x-amz-content-sha256")) {
      headers.set("x-amz-content-sha256", createHash("sha256").update(bytes).digest("hex"));
    }
    return fetch(`${target.base}${parsed.pathname}${parsed.search}`, { redirect: "manual", ...init, method, headers, body: hasBody ? bytes : undefined });
  }

  private parseClientPath(input: string | URL): URL {
    if (input instanceof URL) {
      if (input.protocol !== "http:" && input.protocol !== "https:") throw new Error(`fetch takes a path, got a ${input.protocol} URL "${input.href}"`);
      if (input.host) throw new Error(`fetch takes a path and query without a host, got "${input.href}"; the router owns the host`);
      return new URL(`${input.pathname}${input.search}`, PLACEHOLDER_ORIGIN);
    }
    if (ABSOLUTE_INPUT.test(input)) throw new Error(`fetch takes a path and query without a host, got "${input}"; the router owns the host`);
    const parsed = new URL(input, PLACEHOLDER_ORIGIN);
    if (parsed.origin !== PLACEHOLDER_ORIGIN) throw new Error(`fetch takes a path and query without a host, got "${input}"; the router owns the host`);
    return parsed;
  }

  private pickRoute(pathname: string, requested: string | undefined): { route: CompiledRoute; method: Method } {
    const matches: CompiledRoute[] = [];
    for (const route of this.routes) {
      let params: Record<string, string> | null;
      try {
        params = matchPath(route.matcher, pathname);
      } catch {
        throw new Error(`Malformed path "${pathname}"`);
      }
      if (params) matches.push(route);
    }
    if (!matches.length) throw new Error(`No route matches "${pathname}"`);
    const methods = [...new Set(matches.map((r) => r.method))];
    if (requested === undefined) {
      if (methods.length > 1) throw new Error(`"${pathname}" matches routes for ${methods.join(", ")}; pass init.method`);
      return { route: matches[0]!, method: matches[0]!.method };
    }
    const method = assertMethod(requested.toUpperCase());
    const route = matches.find((r) => r.method === method);
    if (!route) throw new Error(`Method ${method} is not allowed for "${pathname}"; allowed: ${methods.join(", ")}`);
    return { route, method };
  }

  private async fetchFunctionUrl(route: CompiledRoute, url: string, parsed: URL, original: Request, init: RequestInit): Promise<Response> {
    const unsupported = Object.keys(init).filter((key) => !["method", "headers", "body"].includes(key) && (init as Record<string, unknown>)[key] !== undefined);
    if (unsupported.length) throw new Error(`fetch to a function URL does not support init.${unsupported.join(", init.")}`);
    const forwarded = original.clone() as Request;
    let input: Record<string, unknown>;
    try {
      const params = matchPath(route.matcher, parsed.pathname)!;
      input = buildInput(parseBody(await original.text(), original.headers.get("content-type")), parsed.searchParams, params);
    } catch {
      throw new Error("Malformed request body");
    }
    return this.callFunction(route, url, input, {}, forwarded.headers, route.request ? forwarded : undefined);
  }

  private handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    debug("router", `${req.method} request`);
    const limited = this.checkRateLimit(req);
    if (limited) {
      debug("router", `rate limited ${req.method}`);
      return limited;
    }

    let pathMatched = false;
    for (const route of this.routes) {
      let params: Record<string, string> | null;
      try {
        params = matchPath(route.matcher, url.pathname);
      } catch {
        return Response.json({ error: "Malformed path" }, { status: 400 });
      }
      if (!params) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      debug("router", `matched ${route.key}`, { name: route.name, public: route.public, params: Object.keys(params) });
      let context: RequestContext = {};
      if (this.options.authenticate && !route.public) {
        let principal: Awaited<ReturnType<Authenticator>>;
        try {
          principal = await this.options.authenticate(req);
        } catch (err) {
          console.error(err);
          debug("router", `authentication failed: ${errorSummary(err)}`);
          return Response.json({ error: "Authentication unavailable" }, { status: 503 });
        }
        if (!principal) {
          debug("router", `rejected ${route.key}: no valid principal`);
          return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
        }
        debug("router", `authenticated ${route.key}`);
        context = { auth: principal };
      }
      const original = route.request ? (req.clone() as Request) : undefined;
      let input: Record<string, unknown>;
      try {
        input = buildInput(parseBody(await req.text(), req.headers.get("content-type")), url.searchParams, params);
      } catch {
        return Response.json({ error: "Malformed request body" }, { status: 400 });
      }
      return this.dispatch(route, input, context, req, original, params);
    }
    debug("router", pathMatched ? `method not allowed for ${req.method}` : `no route for ${req.method} ${url.pathname}`);
    return Response.json({ error: "Not found" }, { status: pathMatched ? 405 : 404 });
  };

  listen(port: number = Number(process.env.PORT ?? 3000)): Record<string, string> {
    // Importing the router in Lambda does not serve.
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) return {};
    if (this.mode === "remote" && !this.loadEndpoints()) {
      throw new Error("Remote mode needs deployed endpoints; run cloudgear apply or pass endpoints");
    }
    this.server = Bun.serve({ port, fetch: this.handle });
    console.log(`cloudgear: ${this.routes.length} route(s) on ${this.server.url} (${this.mode})`);
    return this.urls();
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }

  // Path params stay as {placeholders}; remote mode uses deployed URL.
  urls(): Record<string, string> {
    const resolve = this.resolver();
    const urls: Record<string, string> = {};
    for (const route of this.routes) {
      const target = resolve(route);
      if (target) urls[route.name] = `${target.base}${route.path}`;
    }
    return urls;
  }

  private resolver(): (route: CompiledRoute) => Target | undefined {
    const remote = this.mode === "remote";
    const endpoints = remote ? this.loadEndpoints() : null;
    if (remote && !endpoints) throw new Error("Remote mode needs deployed endpoints; run cloudgear apply or pass endpoints");
    const local = this.server?.url.origin;
    const apiDomain = remote ? (this.options.cert?.domain ?? endpoints?.api?.domain) : undefined;
    if (apiDomain) {
      const kind = !this.options.cert && servedByCdn(endpoints?.api) ? "cdn" : "api";
      return () => ({ kind, base: `https://${apiDomain}` });
    }
    if (!endpoints && !local) throw new Error("No deployed endpoints and the router is not listening; call listen() first");
    return (route) => {
      const base = endpoints ? endpoints.routes[route.key] : local;
      if (!base) return undefined;
      return { kind: endpoints ? "function" : "local", base: base.replace(/\/$/, "") };
    };
  }

  private checkRateLimit(req: Request): Response | null {
    const limit = this.options.rateLimit;
    if (!limit) return null;
    const key = limit.key ? limit.key(req) : (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown");
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || now - window.start >= limit.windowMs) {
      if (!window && this.windows.size >= MAX_TRACKED_CLIENTS) {
        this.windows.delete(this.windows.keys().next().value!);
      }
      this.windows.delete(key);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (++window.count <= limit.limit) return null;
    const retryAfter = Math.max(1, Math.ceil((window.start + limit.windowMs - now) / 1000));
    return Response.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": String(retryAfter) } });
  }

  private async handlerOf(route: CompiledRoute): Promise<{ fn?: (...args: any[]) => unknown; error?: string }> {
    if (route.fn) return { fn: route.fn };
    let loaded: unknown;
    try {
      loaded = (await import(route.script!)).default;
    } catch (err) {
      console.error(err);
      return { error: "Route script failed to load" };
    }
    if (typeof loaded !== "function") return { error: "Route script has no default export function" };
    route.fn = loaded as (...args: any[]) => unknown;
    return { fn: route.fn };
  }

  private async dispatch(route: CompiledRoute, input: Record<string, unknown>, context: RequestContext, req: Request, original?: Request, params?: Record<string, string>): Promise<Response> {
    debug("router", `dispatching ${route.key} in ${this.mode} mode`, () => ({ inputKeys: Object.keys(input) }));
    if (this.mode === "local") {
      const { fn, error } = await this.handlerOf(route);
      if (!fn) return Response.json({ error }, { status: 500 });
      const vercel = original ? vercelRequestFrom({ method: original.method, url: original.url, headers: Object.fromEntries(original.headers), raw: new Uint8Array(await original.arrayBuffer()) }, params) : undefined;
      const result = await timed("router", `local call ${route.key}`, () => invoke(fn, input, context, { request: vercel, response: route.response }));
      debug("router", `local ${route.key} -> ${result.status}`);
      const headers = new Headers(result.headers);
      for (const cookie of result.cookies ?? []) headers.append("set-cookie", cookie);
      return new Response((result.base64 ? Buffer.from(result.body, "base64") : result.body) || null, { status: result.status, headers });
    }
    const url = this.loadEndpoints()?.routes[route.key];
    if (!url) {
      debug("router", `no deployed endpoint for ${route.key}`, { known: Object.keys(this.loadEndpoints()?.routes ?? {}) });
      return Response.json({ error: `No deployed endpoint for "${route.key}"` }, { status: 502 });
    }
    return this.callFunction(route, url, input, context, req.headers, original);
  }

  private async callFunction(route: CompiledRoute, url: string, input: Record<string, unknown>, context: RequestContext, requestHeaders: { get(name: string): string | null }, original?: Request): Promise<Response> {
    let upstream: Response;
    try {
      const header = (this.options.authenticate as { header?: string } | undefined)?.header;
      // `authorization` is taken by SigV4; use a dedicated header.
      const token = header && header !== "authorization" && !route.public ? requestHeaders.get(header) : null;
      upstream = await request(url, input, {
        route: route.key,
        context,
        original: original ? await serializeRequest(original) : undefined,
        headers: token && header ? { [header]: token } : undefined,
        sign: this.authMode(this.loadEndpoints()) === "iam" ? { credentials: this.options.credentials, region: this.options.region } : undefined,
      });
    } catch (err) {
      console.error(err);
      debug("router", `remote call to ${route.key} failed: ${errorSummary(err)}`);
      return Response.json({ error: "Function unreachable" }, { status: 502 });
    }
    debug("router", `remote ${route.key} -> ${upstream.status}`);
    const headers = new Headers(upstream.headers);
    // Decoded body: headers describing the raw bytes are stale.
    for (const name of ["content-encoding", "content-length", "transfer-encoding"]) headers.delete(name);
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  private authMode(endpoints: Endpoints | null): Authentication {
    return this.options.authenticated ?? endpoints?.auth ?? (this.provider === "aws" ? "iam" : "none");
  }

  private loadEndpoints(): Endpoints | null {
    if (this.endpoints !== undefined) return this.endpoints;
    this.endpoints = this.options.endpoints
      ? { routes: this.options.endpoints }
      : readEndpoints(this.provider, this.options.endpointsFile);
    return this.endpoints;
  }
}

export async function request(
  url: string,
  input: unknown,
  init: {
    route?: string;
    context?: RequestContext;
    original?: OriginalRequest;
    headers?: Record<string, string>;
    sign?: { credentials?: AwsCredentialsProvider; region?: string };
  } = {},
): Promise<Response> {
  const body = JSON.stringify({ input, context: init.context ?? {}, ...(init.original ? { request: init.original } : {}) });
  const headers: Record<string, string> = {
    "content-type": INVOKE_CONTENT_TYPE,
    ...(init.route ? { [ROUTE_HEADER]: init.route } : {}),
    ...init.headers,
  };
  const finalHeaders = init.sign ? await signFunctionUrlRequest(url, body, headers, init.sign) : headers;
  const target = new URL(url);
  // Redirects are not followed; a stale signature would be resent.
  return timed("router", `POST ${target.host}${target.pathname}`, () => fetch(url, { method: "POST", headers: finalHeaders, body, redirect: "manual" }), {
    route: init.route,
    signed: !!init.sign,
    bytes: body.length,
  });
}

function servedByCdn(api: Endpoints["api"]): boolean {
  if (!api) return false;
  if (api.via) return true;
  try {
    return !!api.url && CLOUDFRONT_HOST.test(new URL(api.url).hostname);
  } catch {
    return false;
  }
}

function readEndpoints(provider: string, file?: string): Endpoints | null {
  if (process.env.CLOUDGEAR_ENDPOINTS) {
    const routes = JSON.parse(process.env.CLOUDGEAR_ENDPOINTS);
    return Object.keys(routes).length ? { routes } : null;
  }
  const resolved = file ?? process.env.CLOUDGEAR_ENDPOINTS_FILE ?? findUp(process.cwd(), DEFAULT_ENDPOINTS_FILE);
  if (!resolved || !fs.existsSync(resolved)) return null;
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as EndpointsFile;
  if (parsed.provider !== provider) {
    throw new Error(`${resolved} was deployed for provider "${parsed.provider}", router uses "${provider}"`);
  }
  if (Object.keys(parsed.routes).length === 0) return null;
  const apiDomain = typeof parsed.api?.domain === "string" ? parsed.api.domain : undefined;
  const apiUrl = typeof parsed.api?.url === "string" ? parsed.api.url : undefined;
  return { routes: parsed.routes, auth: parsed.auth, ...(apiDomain ? { api: { domain: apiDomain, ...(apiUrl ? { url: apiUrl } : {}), ...(parsed.api?.via === "cloudfront" ? { via: "cloudfront" as const } : {}) } } : {}) };
}

// Stops at nearest package.json; parent endpoints are not used.
function findUp(dir: string, relativeFile: string): string | undefined {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const candidate = path.join(current, relativeFile);
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(current, "package.json")) || path.dirname(current) === current) return undefined;
  }
}

const THIS_FILE = fileURLToPath(import.meta.url);
const STACK_FILE = /(?:\(|\bat\s+)((?:file:\/\/)?\/.+?):\d+:\d+\)?\s*$/;

// "./x" is file-relative; "/x" and "x" are project-root-relative.
function scriptPath(script: string): string {
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  for (const frame of frames) {
    const found = STACK_FILE.exec(frame)?.[1];
    const file = found?.startsWith("file://") ? fileURLToPath(found) : found;
    if (!file || file === THIS_FILE) continue;
    if (script.startsWith("./") || script.startsWith("../")) return path.resolve(path.dirname(file), script);
    const manifest = findUp(path.dirname(file), "package.json");
    const root = manifest ? path.dirname(manifest) : path.dirname(file);
    const resolved = path.join(root, script.replace(/^\/+/, ""));
    const fromRoot = path.relative(root, resolved);
    if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`)) throw new Error(`Route script "${script}" leaves the project`);
    return resolved;
  }
  throw new Error(`Cannot tell which file called url() for the script "${script}"; pass a function instead`);
}
