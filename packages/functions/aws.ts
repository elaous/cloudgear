import {
  INVOKE_CONTENT_TYPE,
  buildInput,
  compilePath,
  invoke,
  matchPath,
  parseBody,
  type Handler,
  type HttpResult,
  type RouteSpec,
} from "./http";

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

export function createHandler(fn: Handler, routes: RouteSpec[]) {
  const compiled = routes.map((route) => ({ ...route, matcher: compilePath(route.path) }));

  return async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
    const headers = lowerCaseKeys(event.headers ?? {});
    const text = event.body
      ? event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body
      : "";
    const contentType = headers["content-type"] ?? null;

    let input: unknown;
    try {
      input = resolveInput(compiled, event, text, contentType);
    } catch (err) {
      return toLambda({ status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: (err as Error).message }) });
    }
    if (input === undefined) {
      return toLambda({ status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Not found" }) });
    }
    return toLambda(await invoke(fn, input));
  };
}

function resolveInput(
  routes: (RouteSpec & { matcher: ReturnType<typeof compilePath> })[],
  event: FunctionUrlEvent,
  text: string,
  contentType: string | null,
): unknown {
  if (contentType?.startsWith(INVOKE_CONTENT_TYPE)) return text ? JSON.parse(text) : {};

  const method = event.requestContext.http.method.toUpperCase();
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.matcher, event.rawPath);
    if (!params) continue;
    return buildInput(parseBody(text, contentType), new URLSearchParams(event.rawQueryString ?? ""), params);
  }
  return undefined;
}

function toLambda(result: HttpResult): FunctionUrlResult {
  return { statusCode: result.status, headers: result.headers, body: result.body };
}

function lowerCaseKeys(record: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key.toLowerCase()] = value;
  return out;
}
