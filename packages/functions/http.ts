import { VercelRequest, VercelResponse, type VercelRequestQuery } from "./vercel";

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
  name?: string;
  method: Method;
  path: string;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  // The body is base64 of binary content.
  base64?: boolean;
  // Set-Cookie values, which cannot be joined into one header.
  cookies?: string[];
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

// The request as the router forwards it to a function that asked for it; `body` is base64.
export interface OriginalRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const HOP_BY_HOP = new Set(["connection", "content-length", "transfer-encoding"]);

export async function serializeRequest(req: Request): Promise<OriginalRequest> {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key)) headers[key] = value;
  });
  const bytes = req.method === "GET" || req.method === "HEAD" ? new Uint8Array() : new Uint8Array(await req.arrayBuffer());
  return { method: req.method, url: req.url, headers, ...(bytes.length ? { body: Buffer.from(bytes).toString("base64") } : {}) };
}

// Query (with path params), cookies and parsed body, as a Vercel function sees a request.
export function vercelRequestFrom(
  original: { method: string; url: string; headers: Record<string, string>; raw?: Uint8Array },
  params: Record<string, string> = {},
): VercelRequest {
  const url = new URL(original.url);
  const query: VercelRequestQuery = Object.create(null);
  for (const [key, value] of url.searchParams) {
    const earlier = query[key];
    query[key] = earlier === undefined ? value : [...(Array.isArray(earlier) ? earlier : [earlier]), value];
  }
  const text = original.raw?.length ? new TextDecoder().decode(original.raw) : "";
  const headers = Object.fromEntries(Object.entries(original.headers).map(([key, value]) => [key.toLowerCase(), value]));
  return new VercelRequest({
    method: original.method,
    url: `${url.pathname}${url.search}`,
    headers,
    query: { ...query, ...params },
    body: parseBody(text, headers["content-type"] ?? null),
    raw: original.raw,
  });
}

export function vercelRequestFromOriginal(original: OriginalRequest, params?: Record<string, string>): VercelRequest {
  return vercelRequestFrom({ ...original, raw: original.body ? Buffer.from(original.body, "base64") : undefined }, params);
}

export type ResponseKind = "helper" | "writer";

// With `request` the function takes it instead of the input; a `response` kind adds the helper or a
// writer after it, and a writer replaces the return value as the output.
export async function invoke(
  fn: (...args: any[]) => unknown,
  input: unknown,
  context: RequestContext = {},
  call: { request?: VercelRequest; response?: ResponseKind } = {},
): Promise<HttpResult> {
  const writer = call.response === "writer" ? new VercelResponse() : undefined;
  const args = [call.request ?? input, ...(call.response === "helper" ? [response] : writer ? [writer] : []), context];
  try {
    const output = await fn(...args);
    if (writer && (writer.writableEnded || output === undefined)) {
      await writer.settled();
      return writer.result();
    }
    return toHttpResult(output);
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
