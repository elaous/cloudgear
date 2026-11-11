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
}

export interface EndpointsFile {
  provider: string;
  routes: Record<string, string>;
  auth?: EndpointAuth;
  cdn?: { domain: string; url: string; id?: string };
  cdns?: Record<string, { domain: string; url: string; id?: string }>;
  api?: { domain: string; url: string; id?: string };
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
  api?: { domain: string };
}

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

  listen(port: number = Number(process.env.PORT ?? 3000)): Record<string, string> {
    // Importing the router in Lambda does not serve.
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

  // Path params stay as {placeholders}; remote mode uses deployed URL.
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
      // `authorization` is taken by SigV4; use a dedicated header.
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
  return { routes: parsed.routes, auth: parsed.auth, ...(apiDomain ? { api: { domain: apiDomain } } : {}) };
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
