import { createHandler as createCoreHandler, type HandlerOptions } from "./aws";
import type { Handler, RouteSpec } from "../http";

// The Express-style request and response of a Cloud Functions HTTP function.
export interface GcpRequest {
  method: string;
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Uint8Array;
  body?: unknown;
}

export interface GcpResponse {
  status(code: number): unknown;
  set(name: string, value: string): unknown;
  send(body: string): unknown;
}

// Same routing, input and token handling as the AWS adapter; only the request shape differs.
export function createHandler(fn: Handler, routes: RouteSpec[], options: HandlerOptions = {}) {
  const core = createCoreHandler(fn, routes, options);

  return async (req: GcpRequest, res: GcpResponse): Promise<void> => {
    const url = new URL(req.originalUrl ?? req.url ?? "/", "http://function.invalid");
    const result = await core({
      rawPath: url.pathname,
      rawQueryString: url.search.slice(1),
      headers: Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value])),
      body: bodyText(req),
      requestContext: { http: { method: req.method } },
    });
    res.status(result.statusCode);
    for (const [name, value] of Object.entries(result.headers)) res.set(name, value);
    res.send(result.body);
  };
}

function bodyText(req: GcpRequest): string {
  if (req.rawBody) return Buffer.from(req.rawBody).toString("utf8");
  if (typeof req.body === "string") return req.body;
  return req.body && typeof req.body === "object" && Object.keys(req.body).length ? JSON.stringify(req.body) : "";
}
