import { debug, errorSummary, timed } from "@cloudgear/debug";
import type { Authenticator } from "../auth";
import {
  INVOKE_CONTENT_TYPE,
  buildInput,
  compilePath,
  invoke,
  matchPath,
  parseBody,
  vercelRequestFrom,
  vercelRequestFromOriginal,
  type OriginalRequest,
  type ResponseKind,
  type EventInfo,
  type RequestContext,
  type HttpResult,
  type RouteSpec,
} from "../http";

// Lambda function URL payload, format version 2.0.
export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  cookies?: string[];
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

export interface ScheduledEvent {
  source: "aws.events";
  time?: string;
  resources?: string[];
}

// An EventBridge event delivered to a function by a rule.
export interface BusEvent {
  id?: string;
  source: string;
  "detail-type": string;
  time?: string;
  detail?: unknown;
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
  cookies?: string[];
}

export interface HandlerOptions {
  // Honour the router's `context` (the caller's identity). Safe only when callers are IAM-authenticated.
  trustContext?: boolean;
  // Verifies every request itself (token in the request headers) and sets `context.auth`:
  // 401 for a bad token, 503 when the verifier fails. Skipped when `anonymous`.
  authenticate?: Authenticator;
  anonymous?: boolean;
  // The function takes a Vercel-style request instead of the input, and a response after it.
  request?: boolean;
  response?: ResponseKind;
  // Awaited once before the first request or scheduled run (for example to load secrets); a failure is retried.
  prepare?: () => Promise<void>;
}

export function createHandler(fn: (...args: any[]) => unknown, routes: RouteSpec[], options: HandlerOptions = {}) {
  const compiled = routes.map((route) => ({ ...route, matcher: compilePath(route.path) }));
  let prepared: Promise<void> | undefined;
  const prepare = () =>
    options.prepare
      ? (prepared ??= options.prepare().catch((err) => {
          prepared = undefined;
          throw err;
        }))
      : undefined;

  // A run nobody is waiting on: a failure is thrown so Lambda records and retries it.
  const runAsync = async (what: string, input: unknown, context: RequestContext) => {
    await prepare();
    const request = options.request
      ? vercelRequestFrom({ method: "POST", url: `https://${what}.invalid/`, headers: { "content-type": "application/json" }, raw: new TextEncoder().encode(JSON.stringify(input)) })
      : undefined;
    const result = await invoke(fn, input, context, { request, response: options.response });
    if (result.status >= 400) throw new Error(`${what === "schedule" ? "Scheduled" : "Event"} run failed with status ${result.status}`);
    return toLambda(result);
  };

  return async (event: FunctionUrlEvent | ScheduledEvent | BusEvent): Promise<FunctionUrlResult> => {
    if (isScheduled(event)) {
      debug("lambda", "scheduled event", { time: event.time, rule: event.resources?.[0] });
      return runAsync("schedule", { scheduledTime: event.time, rule: event.resources?.[0] }, {});
    }
    if (isBusEvent(event)) {
      debug("lambda", "bus event", { type: event["detail-type"], source: event.source, id: event.id });
      const info: EventInfo = { id: event.id ?? "", type: event["detail-type"], source: event.source, ...(event.time ? { time: event.time } : {}) };
      const detail = event.detail;
      const input = typeof detail === "object" && detail !== null && !Array.isArray(detail) ? detail : { detail };
      return runAsync("event", input, { event: info });
    }
    try {
      await prepare();
    } catch (err) {
      console.error(err);
      debug("lambda", `preparation failed: ${errorSummary(err)}`);
      return toLambda(json(500, { error: "Function initialization failed" }));
    }
    const headers = lowerCaseKeys(event.headers ?? {});
    const text = event.body
      ? event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body
      : "";
    const contentType = headers["content-type"] ?? null;

    // Unauthenticated callers learn nothing about routes: verify before parsing or routing.
    let context: RequestContext | undefined;
    if (options.authenticate && !options.anonymous) {
      const req = new Request("https://function.invalid/", { headers });
      let principal: Awaited<ReturnType<Authenticator>>;
      try {
        principal = await options.authenticate(req);
      } catch (err) {
        console.error(err);
        debug("lambda", `token verification unavailable: ${errorSummary(err)}`);
        return toLambda(json(503, { error: "Authentication unavailable" }));
      }
      if (!principal) {
        debug("lambda", "rejected: no valid token");
        return toLambda(json(401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" }));
      }
      debug("lambda", "token verified");
      context = { auth: principal };
    }

    let resolved: Resolved | undefined;
    debug("lambda", `${event.requestContext.http.method} request`, { invokeProtocol: !!contentType?.startsWith(INVOKE_CONTENT_TYPE), bytes: text.length });
    try {
      resolved = resolveInput(compiled, event, text, contentType, options.trustContext ?? false);
    } catch (err) {
      debug("lambda", `bad request: ${errorSummary(err)}`);
      return toLambda({ status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: (err as Error).message }) });
    }
    if (!resolved) {
      debug("lambda", `no route for ${event.requestContext.http.method} ${event.rawPath}`);
      return toLambda({ status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Not found" }) });
    }
    const request = options.request
      ? resolved.original
        ? vercelRequestFromOriginal(resolved.original, resolved.params)
        : requestFromEvent(event, headers, resolved.params)
      : undefined;
    const result = await timed("lambda", "handler", () => invoke(fn, resolved.input, context ?? resolved.context, { request, response: options.response }), () => ({ inputKeys: Object.keys(resolved.input as object) }));
    debug("lambda", `responded ${result.status}`);
    // A HEAD request served by a GET route gets the headers without the body.
    return toLambda(resolved.headOnly ? { ...result, body: "" } : result);
  };
}

function isScheduled(event: FunctionUrlEvent | ScheduledEvent | BusEvent): event is ScheduledEvent {
  return !("requestContext" in event) && (event as ScheduledEvent).source === "aws.events";
}

function isBusEvent(event: FunctionUrlEvent | ScheduledEvent | BusEvent): event is BusEvent {
  return !("requestContext" in event) && typeof (event as BusEvent)["detail-type"] === "string" && typeof (event as BusEvent).source === "string";
}

interface Resolved {
  input: unknown;
  context: RequestContext;
  headOnly?: boolean;
  original?: OriginalRequest;
  params?: Record<string, string>;
}

// The URL host is the one the function URL received; a CDN does not forward the viewer's.
function requestFromEvent(event: FunctionUrlEvent, headers: Record<string, string>, params?: Record<string, string>) {
  if (event.cookies?.length) headers = { ...headers, cookie: event.cookies.join("; ") };
  const method = event.requestContext.http.method.toUpperCase();
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const raw = !event.body || method === "GET" || method === "HEAD" ? undefined : event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body);
  return vercelRequestFrom({ method, url: `https://${headers.host ?? "function.invalid"}${event.rawPath}${query}`, headers, raw }, params);
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
    const original = trustContext && isOriginalRequest(payload.request) ? payload.request : undefined;
    const params = original ? paramsFor(routes, original.method, new URL(original.url).pathname) : paramsFor(routes, event.requestContext.http.method.toUpperCase(), event.rawPath);
    return { input: payload.input, context, original, params };
  }

  const method = event.requestContext.http.method.toUpperCase();
  const params = paramsFor(routes, method, event.rawPath);
  if (!params) return undefined;
  const headOnly = method === "HEAD" && !routes.some((route) => route.method === "HEAD" && matchPath(route.matcher, event.rawPath));
  return {
    input: buildInput(parseBody(text, contentType), new URLSearchParams(event.rawQueryString ?? ""), params),
    context: {},
    headOnly,
    params,
  };
}

function paramsFor(routes: (RouteSpec & { matcher: ReturnType<typeof compilePath> })[], method: string, pathname: string): Record<string, string> | undefined {
  const find = (wanted: string) => {
    for (const route of routes) {
      if (route.method !== wanted) continue;
      const params = matchPath(route.matcher, pathname);
      if (params) return params;
    }
    return undefined;
  };
  return find(method) ?? (method === "HEAD" ? find("GET") : undefined);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResult {
  return { status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

function toLambda(result: HttpResult): FunctionUrlResult {
  return {
    statusCode: result.status,
    headers: result.headers,
    body: result.body,
    ...(result.base64 ? { isBase64Encoded: true } : {}),
    ...(result.cookies ? { cookies: result.cookies } : {}),
  };
}

function lowerCaseKeys(record: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key.toLowerCase()] = value;
  return out;
}

function isOriginalRequest(value: unknown): value is OriginalRequest {
  const candidate = value as Partial<OriginalRequest> | null;
  return typeof candidate === "object" && candidate !== null && typeof candidate.method === "string" && typeof candidate.url === "string" && typeof candidate.headers === "object" && candidate.headers !== null;
}
