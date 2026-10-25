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

export interface EndpointsFile {
  provider: string;
  routes: Record<string, string>;
}

export interface FunctionRouterOptions {
  // "local" runs handlers in-process; "remote" calls the deployed function URLs.
  mode?: "local" | "remote";
  endpoints?: Record<string, string>;
  endpointsFile?: string;
}

interface CompiledRoute {
  method: Method;
  path: string;
  key: string;
  matcher: ReturnType<typeof compilePath>;
  fn: Handler;
}

export const DEFAULT_ENDPOINTS_FILE = ".cloudgear/endpoints.json";

export class FunctionRouter {
  private readonly routes: CompiledRoute[] = [];
  private endpoints: Record<string, string> | null | undefined;

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
      const params = matchPath(route.matcher, url.pathname);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      const body = parseBody(await req.text(), req.headers.get("content-type"));
      return this.dispatch(route, buildInput(body, url.searchParams, params));
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
    const url = this.loadEndpoints()?.[route.key];
    if (!url) {
      return Response.json({ error: `No deployed endpoint for "${route.key}"` }, { status: 502 });
    }
    const upstream = await request(url, input, { route: route.key });
    const headers = new Headers(upstream.headers);
    // fetch() already decoded the body, so these no longer describe it.
    for (const name of ["content-encoding", "content-length", "transfer-encoding"]) headers.delete(name);
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  private loadEndpoints(): Record<string, string> | null {
    if (this.endpoints !== undefined) return this.endpoints;
    this.endpoints = this.options.endpoints ?? readEndpoints(this.provider, this.options.endpointsFile);
    return this.endpoints;
  }
}

export function request(
  url: string,
  input: unknown,
  init: { route?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": INVOKE_CONTENT_TYPE,
      ...(init.route ? { [ROUTE_HEADER]: init.route } : {}),
      ...init.headers,
    },
    body: JSON.stringify(input),
  });
}

function readEndpoints(provider: string, file?: string): Record<string, string> | null {
  if (process.env.CLOUDGEAR_ENDPOINTS) return JSON.parse(process.env.CLOUDGEAR_ENDPOINTS);
  const resolved = path.resolve(file ?? process.env.CLOUDGEAR_ENDPOINTS_FILE ?? DEFAULT_ENDPOINTS_FILE);
  if (!fs.existsSync(resolved)) return null;
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as EndpointsFile;
  if (parsed.provider !== provider) {
    throw new Error(`${resolved} was deployed for provider "${parsed.provider}", router uses "${provider}"`);
  }
  return parsed.routes;
}
