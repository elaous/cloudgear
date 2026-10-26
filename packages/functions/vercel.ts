import { Readable, Writable } from "node:stream";

export type VercelRequestQuery = Record<string, string | string[]>;

export interface VercelRequestInit {
  method: string;
  // Path and query, as in IncomingMessage.url.
  url: string;
  headers: Record<string, string>;
  query: VercelRequestQuery;
  body: unknown;
  raw?: Uint8Array;
}

// The subset of IncomingMessage & { query, cookies, body } that handlers use.
export class VercelRequest extends Readable {
  readonly httpVersion = "1.1";
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly query: VercelRequestQuery;
  readonly cookies: Record<string, string>;
  readonly body: unknown;

  constructor(init: VercelRequestInit) {
    super();
    this.method = init.method;
    this.url = init.url;
    this.headers = init.headers;
    this.query = init.query;
    this.body = init.body;
    this.cookies = parseCookies(init.headers.cookie);
    if (init.raw?.length) this.push(Buffer.from(init.raw));
    this.push(null);
  }

  override _read(): void {}
}

// The subset of ServerResponse & { send, json, status, redirect } that handlers use.
export class VercelResponse extends Writable {
  statusCode = 200;
  readonly chunks: Buffer[] = [];
  private readonly headers = new Map<string, string | string[]>();

  get headersSent(): boolean {
    return this.writableEnded;
  }

  setHeader(name: string, value: string | number | string[]): this {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value : String(value));
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    return this.headers.get(name.toLowerCase());
  }

  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
  }

  writeHead(status: number, headers: Record<string, string | number | string[]> = {}): this {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  send(body?: unknown): this {
    if (body === undefined || body === null) return this.finish();
    if (ArrayBuffer.isView(body)) return this.typed("application/octet-stream").finish(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    if (body instanceof ArrayBuffer) return this.typed("application/octet-stream").finish(Buffer.from(body));
    if (typeof body === "string") return this.typed("text/html; charset=utf-8").finish(body);
    return this.json(body);
  }

  json(body: unknown): this {
    return this.typed("application/json; charset=utf-8").finish(JSON.stringify(body));
  }

  redirect(statusOrUrl: string | number, url?: string): this {
    this.statusCode = typeof statusOrUrl === "number" ? statusOrUrl : 307;
    this.setHeader("location", typeof statusOrUrl === "number" ? (url ?? "") : statusOrUrl);
    return this.finish();
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    done();
  }

  // Text bodies as utf8; any other content type as base64. `cookies` are the Set-Cookie values.
  result(): { status: number; headers: Record<string, string>; body: string; base64?: boolean; cookies?: string[] } {
    const headers: Record<string, string> = {};
    let cookies: string[] | undefined;
    for (const [name, value] of this.headers) {
      if (name === "set-cookie") cookies = Array.isArray(value) ? value : [value];
      else headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    const raw = Buffer.concat(this.chunks);
    const type = headers["content-type"];
    const binary = raw.length > 0 && type !== undefined && !TEXTUAL.test(type);
    return { status: this.statusCode, headers, body: raw.toString(binary ? "base64" : "utf8"), ...(binary ? { base64: true } : {}), ...(cookies ? { cookies } : {}) };
  }

  // Resolves once the writer has flushed everything, which needs the function to end it.
  settled(): Promise<void> {
    if (this.writableFinished) return Promise.resolve();
    return new Promise((resolve) => this.once("finish", () => resolve()));
  }

  private typed(type: string): this {
    if (!this.headers.has("content-type")) this.setHeader("content-type", type);
    return this;
  }

  private finish(body?: string | Buffer): this {
    this.end(body);
    return this;
  }
}

const TEXTUAL = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|[^;]*\+(json|xml))/i;

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of (header ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at < 1) continue;
    const value = pair.slice(at + 1).trim();
    try {
      cookies[pair.slice(0, at).trim()] = decodeURIComponent(value);
    } catch {
      cookies[pair.slice(0, at).trim()] = value;
    }
  }
  return cookies;
}
