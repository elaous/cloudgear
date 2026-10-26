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
    if (Buffer.isBuffer(body)) return this.typed("application/octet-stream").finish(body);
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

  result(): { status: number; headers: Record<string, string>; body: string } {
    const headers: Record<string, string> = {};
    for (const [name, value] of this.headers) headers[name] = Array.isArray(value) ? value.join(", ") : value;
    return { status: this.statusCode, headers, body: Buffer.concat(this.chunks).toString("utf8") };
  }

  // Resolves once everything written, or piped in, has been flushed.
  settled(): Promise<void> {
    if (!this.writableEnded || this.writableFinished) return Promise.resolve();
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
