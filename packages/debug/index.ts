export type DebugSink = (line: string) => void;

const writeToStderr: DebugSink = (line) => void process.stderr.write(`${line}\n`);
let sink = writeToStderr;

// Read on every call, so setting CG_DEBUG after startup takes effect.
export function isDebug(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.CG_DEBUG ?? "");
}

export function setDebugSink(next?: DebugSink): void {
  sink = next ?? writeToStderr;
}

const SENSITIVE =
  /authorization|cookie|token|secret|passw|^pwd$|credential|accesskeyid|api[-_]?key|private[-_]?key|customerkey|signature|session|jwt|bearer|policy|environment|variables|zipfile|^body$|^headers$|^payload$|^input$|^value$|claims|^context$/i;
const MAX_STRING = 160;
const MAX_ITEMS = 10;
const MAX_DEPTH = 3;

// Drops values that could hold secrets or large payloads.
export function redact(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE.test(key)) return "[redacted]";
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length} chars)` : value;
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[${value.length} items]` : "[object]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => redact(item, key, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `…${value.length - MAX_ITEMS} more`] : items;
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k, depth + 1)]));
  }
  return String(value);
}

// Lazy: data is built only when debugging is on.
export type DebugData = Record<string, unknown> | (() => Record<string, unknown>);

export function debug(scope: string, message: string, data?: DebugData): void {
  if (!isDebug()) return;
  const time = new Date().toISOString().slice(11, 23);
  const resolved = typeof data === "function" ? data() : data;
  const detail = resolved && Object.keys(resolved).length ? ` ${JSON.stringify(redact(resolved))}` : "";
  sink(`[cg:debug ${time}] ${scope}: ${message}${detail}`);
}

// Parse errors can quote request bodies.
export function errorSummary(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === "SyntaxError") return "SyntaxError: invalid input";
  return `${e?.name ?? "Error"}: ${(e?.message ?? String(err)).slice(0, 300)}`;
}

export async function timed<T>(scope: string, message: string, run: () => Promise<T>, data?: DebugData): Promise<T> {
  if (!isDebug()) return run();
  const started = performance.now();
  try {
    const result = await run();
    debug(scope, `${message} ok (${Math.round(performance.now() - started)}ms)`, data);
    return result;
  } catch (err) {
    debug(scope, `${message} failed (${Math.round(performance.now() - started)}ms): ${errorSummary(err)}`, data);
    throw err;
  }
}
