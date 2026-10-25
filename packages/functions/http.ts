export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type Method = (typeof METHODS)[number];

export type Provider = "aws" | "gcp" | "azure";

// Body of a router -> function call: the already-assembled input object.
export const INVOKE_CONTENT_TYPE = "application/vnd.cloudgear.invoke+json";
export const ROUTE_HEADER = "x-cloudgear-route";

export type PathParams<P extends string> = P extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PathParams<Rest>
  : never;

const RESPONSE = Symbol.for("cloudgear.response");

export interface CloudgearResponse<T = unknown> {
  readonly [RESPONSE]: true;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: T;
}

// O may include CloudgearResponse values to set status or headers.
export type Handler<I = any, O = unknown> = (input: I, context: RequestContext) => O | Promise<O>;

// Who is calling, as established by the router's `authenticate` hook.
export interface Principal {
  subject: string;
  claims: Record<string, unknown>;
}

export interface RequestContext {
  auth?: Principal;
}

export interface RouteSpec {
  method: Method;
  path: string;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function response<T>(
  body: T,
  init: { status?: number; headers?: Record<string, string> } = {},
): CloudgearResponse<T> {
  return { [RESPONSE]: true, status: init.status ?? 200, headers: init.headers ?? {}, body };
}

export function isResponse(value: unknown): value is CloudgearResponse {
  return typeof value === "object" && value !== null && RESPONSE in value;
}

export function routeKey(route: RouteSpec): string {
  return `${route.method} ${route.path}`;
}

export function assertMethod(method: string): Method {
  const upper = method.toUpperCase();
  if (!(METHODS as readonly string[]).includes(upper)) {
    throw new Error(`Unsupported HTTP method "${method}", expected one of ${METHODS.join(", ")}`);
  }
  return upper as Method;
}

const PARAM = /\{([A-Za-z_$][\w$]*)\}/g;

export function compilePath(path: string): { regex: RegExp; params: string[] } {
  if (!path.startsWith("/")) throw new Error(`Route path "${path}" must start with "/"`);
  const params: string[] = [];
  let source = "";
  let last = 0;
  for (const match of path.matchAll(PARAM)) {
    source += escapeRegex(path.slice(last, match.index));
    source += "([^/]+)";
    params.push(match[1]!);
    last = match.index! + match[0].length;
  }
  source += escapeRegex(path.slice(last));
  return { regex: new RegExp(`^${source}/?$`), params };
}

export function matchPath(
  compiled: { regex: RegExp; params: string[] },
  pathname: string,
): Record<string, string> | null {
  const match = compiled.regex.exec(pathname);
  if (!match) return null;
  const params: Record<string, string> = Object.create(null);
  compiled.params.forEach((name, i) => {
    params[name] = decodeURIComponent(match[i + 1]!);
  });
  return params;
}

// Precedence, lowest to highest: body fields, query params, path params.
export function buildInput(
  body: unknown,
  query: URLSearchParams,
  params: Record<string, string>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const set = (key: string, value: unknown) =>
    Object.defineProperty(input, key, { value, enumerable: true, writable: true, configurable: true });
  if (isPlainObject(body)) for (const [key, value] of Object.entries(body)) set(key, value);
  else if (body !== undefined) set("body", body);
  for (const key of new Set(query.keys())) {
    const values = query.getAll(key);
    set(key, values.length > 1 ? values : values[0]);
  }
  for (const [key, value] of Object.entries(params)) set(key, value);
  return input;
}

export function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return undefined;
  if (contentType?.includes("json")) return JSON.parse(text);
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return text;
}

export async function invoke(fn: Handler, input: unknown, context: RequestContext = {}): Promise<HttpResult> {
  try {
    return toHttpResult(await fn(input, context));
  } catch (err) {
    console.error(err);
    return toHttpResult(response({ error: "Internal Server Error" }, { status: 500 }));
  }
}

export function toHttpResult(output: unknown): HttpResult {
  const res = isResponse(output) ? output : response(output);
  if (res.status === 204 || res.body === undefined) {
    return { status: res.status, headers: { ...res.headers }, body: "" };
  }
  return {
    status: res.status,
    headers: { "content-type": "application/json", ...res.headers },
    body: JSON.stringify(res.body),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
