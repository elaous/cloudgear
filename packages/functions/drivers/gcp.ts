import { createHandler as createCoreHandler, type HandlerOptions } from "./aws";
import type { Handler, RouteSpec } from "../http";

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

// Request context is never trusted: nothing authenticates callers first.
export function createHandler(fn: Handler, routes: RouteSpec[], options: HandlerOptions = {}) {
  const core = createCoreHandler(fn, routes, { ...options, trustContext: false });

  return async (req: GcpRequest, res: GcpResponse): Promise<void> => {
    const [rawPath = "/", ...query] = (req.originalUrl ?? req.url ?? "/").split("?");
    const headers = Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value]));
    let result;
    try {
      result = await core({
        rawPath: rawPath || "/",
        rawQueryString: query.join("?"),
        headers,
        body: bodyText(req, headers),
        requestContext: { http: { method: req.method } },
      });
    } catch (err) {
      console.error(err);
      result = { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Internal Server Error" }) };
    }
    res.status(result.statusCode);
    for (const [name, value] of Object.entries(result.headers)) res.set(name, value);
    res.send(result.body);
  };
}

// Uses raw bytes; parsed bodies re-encode by content type.
function bodyText(req: GcpRequest, headers: Record<string, string | undefined>): string {
  if (req.rawBody) return Buffer.from(req.rawBody).toString("utf8");
  if (typeof req.body === "string") return req.body;
  if (req.body === undefined || req.body === null || typeof req.body !== "object") return "";
  if (/^application\/x-www-form-urlencoded/i.test(headers["content-type"] ?? "")) {
    return new URLSearchParams(Object.entries(req.body).map(([key, value]): [string, string] => [key, String(value)])).toString();
  }
  return Array.isArray(req.body) || Object.keys(req.body).length ? JSON.stringify(req.body) : "";
}
