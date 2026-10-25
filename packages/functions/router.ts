import fs from "node:fs";
import path from "node:path";
import {
  INVOKE_CONTENT_TYPE,
  ROUTE_HEADER,
  TOKEN_ENV,
  TOKEN_HEADER,
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

export interface EndpointsFile {
  provider: string;
  routes: Record<string, string>;
  token?: string;
}

export interface FunctionRouterOptions {
  // "local" runs handlers in-process; "remote" calls the deployed function URLs.
  mode?: "local" | "remote";
  endpoints?: Record<string, string>;
  endpointsFile?: string;
  token?: string;
}

interface CompiledRoute {
  method: Method;
  path: string;
  key: string;
  matcher: ReturnType<typeof compilePath>;
  fn: Handler;
}

interface Endpoints {
  routes: Record<string, string>;
  token?: string;
}

export const DEFAULT_ENDPOINTS_FILE = ".cloudgear/endpoints.json";

export class FunctionRouter {
  private readonly routes: CompiledRoute[] = [];
  private endpoints: Endpoints | null | undefined;

  constructor(
    readonly provider: Provider,
    private readonly options: FunctionRouterOptions = {},
  ) {}

  add<P extends string, I extends { readonly [K in PathParams<P>]: unknown }, O>(
    method: Method | Lowercase<Method>,
    path: P,
    fn: Handler<I, O>,
  ): this {
    const route = { method: assertMethod(method), path };
    const key = routeKey(route);
    if (this.routes.some((r) => r.key === key)) throw new Error(`Route "${key}" is already registered`);
    this.routes.push({ ...route, key, matcher: compilePath(path), fn: fn as Handler });
    return this;
  }

  get mode(): "local" | "remote" {
    if (this.options.mode) return this.options.mode;
    return this.loadEndpoints() ? "remote" : "local";
  }

  fetch = async (req: Request): Promise<Response> => {
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

  listen(port: number = Number(process.env.PORT ?? 3000)) {
    const server = Bun.serve({ port, fetch: this.fetch });
    console.log(`cloudgear: ${this.routes.length} route(s) on ${server.url} (${this.mode})`);
    return server;
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
      upstream = await request(url, input, { route: route.key, token: endpoints?.token });
    } catch (err) {
      console.error(err);
      return Response.json({ error: "Function unreachable" }, { status: 502 });
    }
    const headers = new Headers(upstream.headers);
    // fetch() already decoded the body, so these no longer describe it.
    for (const name of ["content-encoding", "content-length", "transfer-encoding"]) headers.delete(name);
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  private loadEndpoints(): Endpoints | null {
    if (this.endpoints !== undefined) return this.endpoints;
    this.endpoints = this.options.endpoints
      ? { routes: this.options.endpoints, token: this.options.token ?? process.env[TOKEN_ENV] }
      : readEndpoints(this.provider, this.options.endpointsFile);
    if (this.endpoints && this.options.token) this.endpoints.token = this.options.token;
    return this.endpoints;
  }
}

export function request(
  url: string,
  input: unknown,
  init: { route?: string; token?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": INVOKE_CONTENT_TYPE,
      ...(init.route ? { [ROUTE_HEADER]: init.route } : {}),
      ...(init.token ? { [TOKEN_HEADER]: init.token } : {}),
      ...init.headers,
    },
    body: JSON.stringify(input),
  });
}

function readEndpoints(provider: string, file?: string): Endpoints | null {
  if (process.env.CLOUDGEAR_ENDPOINTS) {
    return { routes: JSON.parse(process.env.CLOUDGEAR_ENDPOINTS), token: process.env[TOKEN_ENV] };
  }
  const resolved = file ?? process.env.CLOUDGEAR_ENDPOINTS_FILE ?? findUp(process.cwd(), DEFAULT_ENDPOINTS_FILE);
  if (!resolved || !fs.existsSync(resolved)) return null;
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as EndpointsFile;
  if (parsed.provider !== provider) {
    throw new Error(`${resolved} was deployed for provider "${parsed.provider}", router uses "${provider}"`);
  }
  // Nothing deployed (for example after destroy): stay in local mode.
  if (Object.keys(parsed.routes).length === 0) return null;
  return { routes: parsed.routes, token: parsed.token };
}

function findUp(dir: string, relativeFile: string): string | undefined {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const candidate = path.join(current, relativeFile);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(current) === current) return undefined;
  }
}
