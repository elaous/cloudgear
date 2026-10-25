import fs from "node:fs";
import path from "node:path";
import {
  INVOKE_CONTENT_TYPE,
  ROUTE_HEADER,
  assertMethod,
  buildInput,
  compilePath,
  invoke,
  matchPath,
  parseBody,
  routeKey,
  type Handler,
  type RequestContext,
  type Method,
  type PathParams,
  type Provider,
} from "./http";
import type { Authenticator } from "./auth";
import { signFunctionUrlRequest, type AwsCredentialsProvider } from "./sign";

export type Authentication = "iam" | "none";
export type EndpointAuth = Authentication;

export interface RouteOptions {
  // Nickname for this route in listen()/urls() results; defaults to the function's name.
  name?: string;
  // Skip the router's `authenticate` hook for this route (for example a health check).
  public?: boolean;
}

export interface EndpointsFile {
  provider: string;
  routes: Record<string, string>;
  auth?: EndpointAuth;
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
  region?: string;
  // Establishes who is calling. Return null for 401; every route requires it unless `public`.
  // The result reaches functions as `context.auth`, and only when `authenticated` is "iam".
  authenticate?: Authenticator;
  // A CDN (from @cloudgear/cdn) serving this router's routes from its own domain. `cloudgear generate`
  // reads it: the CDN then sends each route to its function. Routes through it skip `authenticate`.
  cdn?: { readonly domain: string };
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
  fn: Handler;
}

interface Endpoints {
  routes: Record<string, string>;
  auth?: EndpointAuth;
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

  url<P extends string, I extends { readonly [K in PathParams<P>]: unknown }, O>(
    method: Method | Lowercase<Method>,
    path: P,
    fn: Handler<I, O>,
    options: RouteOptions = {},
  ): this {
    const route = { method: assertMethod(method), path };
    const key = routeKey(route);
    if (this.routes.some((r) => r.key === key)) throw new Error(`Route "${key}" is already registered`);
    const name = options.name ?? (fn.name || key);
    if (!name) throw new Error(`Route "${key}": name must not be empty`);
    if (this.routes.some((r) => r.name === name)) {
      throw new Error(`Route name "${name}" is already used; pass { name } to tell routes apart`);
    }
    this.routes.push({ ...route, key, name, public: options.public ?? false, matcher: compilePath(path), fn: fn as Handler });
    return this;
  }

  get mode(): "local" | "remote" {
    if (this.options.mode) return this.options.mode;
    return this.loadEndpoints() ? "remote" : "local";
  }

  fetch = async (req: Request): Promise<Response> => {
    const limited = this.checkRateLimit(req);
    if (limited) return limited;

    const url = new URL(req.url);
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
      let context: RequestContext = {};
      if (this.options.authenticate && !route.public) {
        let principal: Awaited<ReturnType<Authenticator>>;
        try {
          principal = await this.options.authenticate(req);
        } catch (err) {
          console.error(err);
          return Response.json({ error: "Authentication unavailable" }, { status: 503 });
        }
        if (!principal) {
          return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
        }
        context = { auth: principal };
      }
      let input: Record<string, unknown>;
      try {
        input = buildInput(parseBody(await req.text(), req.headers.get("content-type")), url.searchParams, params);
      } catch {
        return Response.json({ error: "Malformed request body" }, { status: 400 });
      }
      return this.dispatch(route, input, context);
    }
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
    const cdn = remote && this.options.cdn ? `https://${this.options.cdn.domain}` : undefined;
    if (cdn) return Object.fromEntries(this.routes.map((route) => [route.name, `${cdn}${route.path}`]));
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

  private async dispatch(route: CompiledRoute, input: Record<string, unknown>, context: RequestContext): Promise<Response> {
    if (this.mode === "local") {
      const result = await invoke(route.fn, input, context);
      return new Response(result.body || null, { status: result.status, headers: result.headers });
    }
    const endpoints = this.loadEndpoints();
    const url = endpoints?.routes[route.key];
    if (!url) {
      return Response.json({ error: `No deployed endpoint for "${route.key}"` }, { status: 502 });
    }
    let upstream: Response;
    try {
      upstream = await request(url, input, {
        route: route.key,
        context,
        sign: this.authMode(endpoints) === "iam" ? { credentials: this.options.credentials, region: this.options.region } : undefined,
      });
    } catch (err) {
      console.error(err);
      return Response.json({ error: "Function unreachable" }, { status: 502 });
    }
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
    headers?: Record<string, string>;
    sign?: { credentials?: AwsCredentialsProvider; region?: string };
  } = {},
): Promise<Response> {
  const body = JSON.stringify({ input, context: init.context ?? {} });
  const headers: Record<string, string> = {
    "content-type": INVOKE_CONTENT_TYPE,
    ...(init.route ? { [ROUTE_HEADER]: init.route } : {}),
    ...init.headers,
  };
  const finalHeaders = init.sign ? await signFunctionUrlRequest(url, body, headers, init.sign) : headers;
  // Redirects belong to the client; following one here would resend a stale signature.
  return fetch(url, { method: "POST", headers: finalHeaders, body, redirect: "manual" });
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
  return { routes: parsed.routes, auth: parsed.auth };
}

// Stops at the nearest package.json so a parent project's endpoints are never picked up.
function findUp(dir: string, relativeFile: string): string | undefined {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const candidate = path.join(current, relativeFile);
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(path.join(current, "package.json")) || path.dirname(current) === current) return undefined;
  }
}
