import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { debug, errorSummary, timed } from "@cloudgear/debug";
import {
  INVOKE_CONTENT_TYPE,
  ROUTE_HEADER,
  assertMethod,
  buildInput,
  compilePath,
  invoke,
  matchPath,
  parseBody,
  response,
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

// What @cloudgear/secrets (`store.path(...)([...])`, or a path ending in /*) and @cloudgear/events
// (`bus.event(...)`) hand over, described by shape so this package needs neither.
export type EnvOption = { readonly kind: "env"; readonly prefix: string; readonly names: object } | { readonly prefix: string; readonly all: true };
export type EventOption = { readonly kind: "event"; readonly type: string };

export interface RouteOptions {
  // Nickname for this route in listen()/urls() results; defaults to the function's name.
  name?: string;
  // Skip the router's `authenticate` hook for this route (for example a health check).
  public?: boolean;
  // Provider settings of the route's function; literals only.
  options?: ProviderOptions;
  // Files or directories, from the project root, packaged with the function; literals only.
  include?: string | string[];
  // The function takes a Vercel-style request (query, cookies, body) instead of the input.
  request?: boolean;
  // Hands the function a response after its first argument: the `response` helper (it returns its
  // output) or `VercelResponse` (a writer; the function returns nothing). Give the import itself.
  response?: typeof response | typeof VercelResponse;
  // Also run the function on a schedule (UTC): `schedule: cron`*/15 * * * *``.
  schedule?: ScheduleSpec | ScheduleSpec[];
  // Also run the function on events: `on: bus.event("order.created")` (see @cloudgear/events).
  on?: EventOption | EventOption[];
  // Secrets the function reads, filled into its environment: `env: store.path("/app")(["KEY"])`
  // (see @cloudgear/secrets). `generate` reads it, so it MUST be written inline.
  env?: EnvOption | EnvOption[];
}

export interface EndpointsFile {
  provider: string;
  routes: Record<string, string>;
  auth?: EndpointAuth;
  // The deployed CDN, written by `cloudgear apply`; read by `CDN.url()`.
  cdn?: { domain: string; url: string; id?: string };
  api?: { domain: string; url: string; id?: string };
}

export interface RateLimit {
  limit: number;
  windowMs: number;
  // Client identity. Required unless `trustProxy` is set.
  key?: (req: Request) => string;
  // Take the client from the first X-Forwarded-For address. Only enable behind a proxy that
  // sets or overwrites that header; otherwise clients can pick their own identity.
  trustProxy?: boolean;
}

export interface FunctionRouterOptions {
  // "local" runs handlers in-process; "remote" calls the deployed function URLs.
  mode?: "local" | "remote";
  endpoints?: Record<string, string>;
  endpointsFile?: string;
  // "iam": deployed functions require signed calls (the router signs them). "none": public URLs.
  // Read by `cloudgear generate` (so MUST be a string literal); defaults to "iam".
  authenticated?: Authentication;
  credentials?: AwsCredentialsProvider;
  // AWS region of the deployed functions (and the signing region for URLs that do not name one).
  // `cloudgear generate` reads it, so it MUST be a string literal; defaults to --region or AWS_REGION.
  region?: string;
  // Establishes who is calling. Return null for 401; every route requires it unless `public`.
  // The result reaches functions as `context.auth`, and only when `authenticated` is "iam".
  authenticate?: Authenticator;
  // A Cert (from @cloudgear/cdn): routes are also served on its domain through API Gateway.
  // Requests there reach functions directly and skip `authenticate`; `generate` reads it.
  cert?: { readonly domain: string };
  // Provider settings for every function; literals only.
  functionOptions?: ProviderOptions;
  // Secrets every function reads (see RouteOptions.env).
  env?: EnvOption | EnvOption[];
  // Per-process counters: instances of a serverless app do not share them.
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
  // Absolute path of the module whose default export handles the route.
  script?: string;
}

interface Endpoints {
  routes: Record<string, string>;
  auth?: EndpointAuth;
  api?: { domain: string };
}

export const DEFAULT_ENDPOINTS_FILE = ".cloudgear/endpoints.json";
// Oldest counters are dropped past this, so memory stays bounded under key-flooding.
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

  // `script` is a path, relative to the file calling `url`, of a module whose default export handles the route.
  url<P extends string>(method: Method | Lowercase<Method>, path: P, script: string, options?: RouteOptions): this;
  // With `request` the function takes a Vercel-style request instead of the input.
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

  fetch = async (req: Request): Promise<Response> => {
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

  // Starts serving and returns each route's URL by name; see urls().
  listen(port: number = Number(process.env.PORT ?? 3000)): Record<string, string> {
    // A routed function may share a module with the router; inside Lambda that import must not serve.
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) return {};
    if (this.mode === "remote" && !this.loadEndpoints()) {
      throw new Error("Remote mode needs deployed endpoints; run cloudgear apply or pass endpoints");
    }
    this.server = Bun.serve({ port, fetch: this.fetch });
    console.log(`cloudgear: ${this.routes.length} route(s) on ${this.server.url} (${this.mode})`);
    return this.urls();
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }

  // Route name to URL: the deployed function URL in remote mode (with "iam" only signed calls
  // can use it), else this server's.
  // Path params stay as {placeholders}.
  urls(): Record<string, string> {
    const remote = this.mode === "remote";
    const endpoints = remote ? this.loadEndpoints() : null;
    if (remote && !endpoints) throw new Error("Remote mode needs deployed endpoints; run cloudgear apply or pass endpoints");
    const local = this.server?.url.origin;
    const apiDomain = remote ? (this.options.cert?.domain ?? endpoints?.api?.domain) : undefined;
    const api = apiDomain ? `https://${apiDomain}` : undefined;
    if (api) return Object.fromEntries(this.routes.map((route) => [route.name, `${api}${route.path}`]));
    if (!endpoints && !local) throw new Error("No deployed endpoints and the router is not listening; call listen() first");
    const urls: Record<string, string> = {};
    for (const route of this.routes) {
      const base = endpoints ? endpoints.routes[route.key] : local;
      if (base) urls[route.name] = `${base.replace(/\/$/, "")}${route.path}`;
    }
    return urls;
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
    const endpoints = this.loadEndpoints();
    const url = endpoints?.routes[route.key];
    if (!url) {
      debug("router", `no deployed endpoint for ${route.key}`, { known: Object.keys(endpoints?.routes ?? {}) });
      return Response.json({ error: `No deployed endpoint for "${route.key}"` }, { status: 502 });
    }
    let upstream: Response;
    try {
      const header = (this.options.authenticate as { header?: string } | undefined)?.header;
      // `authorization` is taken by the SigV4 signature; only a dedicated header can carry the token.
      const token = header && header !== "authorization" && !route.public ? req.headers.get(header) : null;
      upstream = await request(url, input, {
        route: route.key,
        context,
        original: original ? await serializeRequest(original) : undefined,
        headers: token && header ? { [header]: token } : undefined,
        sign: this.authMode(endpoints) === "iam" ? { credentials: this.options.credentials, region: this.options.region } : undefined,
      });
    } catch (err) {
      console.error(err);
      debug("router", `remote call to ${route.key} failed: ${errorSummary(err)}`);
      return Response.json({ error: "Function unreachable" }, { status: 502 });
    }
    debug("router", `remote ${route.key} -> ${upstream.status}`);
    const headers = new Headers(upstream.headers);
    // fetch() already decoded the body, so these no longer describe it.
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
  // Redirects belong to the client; following one here would resend a stale signature.
  return timed("router", `POST ${target.host}${target.pathname}`, () => fetch(url, { method: "POST", headers: finalHeaders, body, redirect: "manual" }), {
    route: init.route,
    signed: !!init.sign,
    bytes: body.length,
  });
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
  // Nothing deployed (for example after destroy): stay in local mode.
  if (Object.keys(parsed.routes).length === 0) return null;
  const apiDomain = typeof parsed.api?.domain === "string" ? parsed.api.domain : undefined;
  return { routes: parsed.routes, auth: parsed.auth, ...(apiDomain ? { api: { domain: apiDomain } } : {}) };
}

// Stops at the nearest package.json so a parent project's endpoints are never picked up.
function findUp(dir: string, relativeFile: string): string | undefined {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const candidate = path.join(current, relativeFile);
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(current, "package.json")) || path.dirname(current) === current) return undefined;
  }
}

const THIS_FILE = fileURLToPath(import.meta.url);
const STACK_FILE = /(?:\(|\bat\s+)((?:file:\/\/)?\/.+?):\d+:\d+\)?\s*$/;

// "./x" and "../x" resolve against the file that called `url`; "/x" and "x" against its project root.
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
