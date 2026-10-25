import {
  INVOKE_CONTENT_TYPE,
  buildInput,
  compilePath,
  invoke,
  matchPath,
  parseBody,
  type Handler,
  type RequestContext,
  type HttpResult,
  type RouteSpec,
} from "../http";

// Lambda function URL payload, format version 2.0.
export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface HandlerOptions {
  // Honour the router's `context` (the caller's identity). Safe only when callers are IAM-authenticated.
  trustContext?: boolean;
}

export function createHandler(fn: Handler, routes: RouteSpec[], options: HandlerOptions = {}) {
  const compiled = routes.map((route) => ({ ...route, matcher: compilePath(route.path) }));

  return async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
    const headers = lowerCaseKeys(event.headers ?? {});
    const text = event.body
      ? event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body
      : "";
    const contentType = headers["content-type"] ?? null;

    let resolved: Resolved | undefined;
    try {
      resolved = resolveInput(compiled, event, text, contentType, options.trustContext ?? false);
    } catch (err) {
      return toLambda({ status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: (err as Error).message }) });
    }
    if (!resolved) {
      return toLambda({ status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Not found" }) });
    }
    const result = await invoke(fn, resolved.input, resolved.context);
    // A HEAD request served by a GET route gets the headers without the body.
    return toLambda(resolved.headOnly ? { ...result, body: "" } : result);
  };
}

interface Resolved {
  input: unknown;
  context: RequestContext;
  headOnly?: boolean;
}

function resolveInput(
  routes: (RouteSpec & { matcher: ReturnType<typeof compilePath> })[],
  event: FunctionUrlEvent,
  text: string,
  contentType: string | null,
  trustContext: boolean,
): Resolved | undefined {
  if (contentType?.startsWith(INVOKE_CONTENT_TYPE)) {
    const payload = text ? JSON.parse(text) : {};
    if (typeof payload !== "object" || payload === null || Array.isArray(payload) || typeof payload.input !== "object" || payload.input === null) {
      throw new Error("Malformed invoke payload: expected { input, context }");
    }
    const context = trustContext && typeof payload.context === "object" && payload.context !== null ? payload.context : {};
    return { input: payload.input, context };
  }

  const method = event.requestContext.http.method.toUpperCase();
  const find = (wanted: string) => {
    for (const route of routes) {
      if (route.method !== wanted) continue;
      const params = matchPath(route.matcher, event.rawPath);
      if (params) return params;
    }
    return undefined;
  };
  const params = find(method) ?? (method === "HEAD" ? find("GET") : undefined);
  if (!params) return undefined;
  const headOnly = method === "HEAD" && !routes.some((route) => route.method === "HEAD" && matchPath(route.matcher, event.rawPath));
  return {
    input: buildInput(parseBody(text, contentType), new URLSearchParams(event.rawQueryString ?? ""), params),
    context: {},
    headOnly,
  };
}

function toLambda(result: HttpResult): FunctionUrlResult {
  return { statusCode: result.status, headers: result.headers, body: result.body };
}

function lowerCaseKeys(record: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key.toLowerCase()] = value;
  return out;
}
