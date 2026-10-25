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
  type Method,
  type PathParams,
  type Provider,
} from "./http";
import { signFunctionUrlRequest, type AwsCredentialsProvider } from "./sign";

export type Authentication = "iam" | "none";
export type EndpointAuth = Authentication;

export interface RouteOptions {
  // Nickname for this route in listen()/urls() results; defaults to the function's name.
  name?: string;
}

export interface EndpointsFile {
  provider: string;
  routes: Record<string, string>;
  auth?: EndpointAuth;
}

export interface RateLimit {
  limit: number;
  windowMs: number;
  // Client identity; defaults to the first X-Forwarded-For address.
  key?: (req: Request) => string;
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
  // Per-process counters: instances of a serverless app do not share them.
  rateLimit?: RateLimit;
}

interface CompiledRoute {
  method: Method;
  path: string;
  key: string;
  name: string;
  matcher: ReturnType<typeof compilePath>;
  fn: Handler;
}

interface Endpoints {
  routes: Record<string, string>;
  auth?: EndpointAuth;
}

export const DEFAULT_ENDPOINTS_FILE = ".cloudgear/endpoints.json";
const MAX_TRACKED_CLIENTS = 10_000;

export class FunctionRouter {
  private readonly routes: CompiledRoute[] = [];
  private readonly windows = new Map<string, { start: number; count: number }>();
  private endpoints: Endpoints | null | undefined;
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor(
    readonly provider: Provider,
    private readonly options: FunctionRouterOptions = {},
  ) {}

  add<P extends string, I extends { readonly [K in PathParams<P>]: unknown }, O>(
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
    this.routes.push({ ...route, key, name, matcher: compilePath(path), fn: fn as Handler });
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
      let input: Record<string, unknown>;
      try {
        input = buildInput(parseBody(await req.text(), req.headers.get("content-type")), url.searchParams, params);
      } catch {
        return Response.json({ error: "Malformed request body" }, { status: 400 });
      }
      return this.dispatch(route, input);
    }
    return Response.json({ error: "Not found" }, { status: pathMatched ? 405 : 404 });
  };

  // Starts serving and returns each route's URL by name; see urls().
  listen(port: number = Number(process.env.PORT ?? 3000)): Record<string, string> {
    this.server = Bun.serve({ port, fetch: this.fetch });
    console.log(`cloudgear: ${this.routes.length} route(s) on ${this.server.url} (${this.mode})`);
    return this.urls();
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }

  // Route name to URL: the deployed function URL in remote mode, else this server's.
  // Path params stay as {placeholders}.
  urls(): Record<string, string> {
    const endpoints = this.mode === "remote" ? this.loadEndpoints() : null;
    const local = this.server?.url.origin;
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
    const key = limit.key?.(req) ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "global";
    const now = Date.now();
    if (this.windows.size >= MAX_TRACKED_CLIENTS) {
      for (const [client, window] of this.windows) if (now - window.start >= limit.windowMs) this.windows.delete(client);
    }
    let window = this.windows.get(key);
    if (!window || now - window.start >= limit.windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (++window.count <= limit.limit) return null;
    const retryAfter = Math.max(1, Math.ceil((window.start + limit.windowMs - now) / 1000));
    return Response.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": String(retryAfter) } });
  }

  private async dispatch(route: CompiledRoute, input: Record<string, unknown>): Promise<Response> {
    if (this.mode === "local") {
      const result = await invoke(route.fn, input);
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
    headers?: Record<string, string>;
    sign?: { credentials?: AwsCredentialsProvider; region?: string };
  } = {},
): Promise<Response> {
  const body = JSON.stringify(input);
  const headers: Record<string, string> = {
    "content-type": INVOKE_CONTENT_TYPE,
    ...(init.route ? { [ROUTE_HEADER]: init.route } : {}),
    ...init.headers,
  };
  const finalHeaders = init.sign ? await signFunctionUrlRequest(url, body, headers, init.sign) : headers;
  return fetch(url, { method: "POST", headers: finalHeaders, body });
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
