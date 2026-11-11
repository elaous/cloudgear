// Protobuf text format subset used by cloudgear.proto.
export type ProtoValue = string | number | boolean | ProtoMessage | ProtoValue[];
export interface ProtoMessage {
  [field: string]: ProtoValue | undefined;
}

export function encodePrototxt(message: ProtoMessage, header: string[] = []): string {
  const lines = header.map((line) => `# ${line}`);
  if (lines.length) lines.push("");
  encodeFields(message, 0, lines);
  return lines.join("\n") + "\n";
}

function encodeFields(message: ProtoMessage, depth: number, lines: string[]) {
  const indent = "  ".repeat(depth);
  for (const [field, value] of Object.entries(message)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (Array.isArray(item)) throw new Error(`prototxt: nested lists are not supported (field "${field}")`);
      if (typeof item === "object") {
        lines.push(`${indent}${field} {`);
        encodeFields(item, depth + 1, lines);
        lines.push(`${indent}}`);
      } else {
        lines.push(`${indent}${field}: ${encodeScalar(item)}`);
      }
    }
  }
}

function encodeScalar(value: string | number | boolean): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`prototxt: cannot encode ${value}`);
  return String(value);
}

type Token = { kind: "ident" | "string" | "number" | "punct"; text: string; value?: string | number; line: number };

const TOKEN = /\s+|#[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|[A-Za-z_][\w.]*|[{}:\[\],;<>]/y;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(text);
    if (!match) throw new Error(`prototxt:${line}: unexpected character "${text[start]}"`);
    const raw = match[0];
    const c = raw[0]!;
    if (/\s/.test(c) || c === "#") {
    } else if (c === '"' || c === "'") {
      tokens.push({ kind: "string", text: raw, value: unquote(raw), line });
    } else if (/[-\d]/.test(c)) {
      tokens.push({ kind: "number", text: raw, value: Number(raw), line });
    } else if (/[A-Za-z_]/.test(c)) {
      tokens.push({ kind: "ident", text: raw, line });
    } else {
      tokens.push({ kind: "punct", text: raw, line });
    }
    line += raw.split("\n").length - 1;
  }
  return tokens;
}

function unquote(raw: string): string {
  const body = raw.slice(1, -1);
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[0-7]{1,3}|.)/g, (_, esc: string) => {
    if (esc[0] === "x" || esc[0] === "u") return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (/^[0-7]/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    return ({ n: "\n", t: "\t", r: "\r", "0": "\0" } as Record<string, string>)[esc] ?? esc;
  });
}

// `repeated` lists dotted field paths that are always arrays, e.g. "function.route".
export function parsePrototxt(text: string, repeated: ReadonlySet<string> = new Set()): ProtoMessage {
  const tokens = tokenize(text);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => {
    const token = tokens[pos++];
    if (!token) throw new Error("prototxt: unexpected end of input");
    return token;
  };
  const fail = (token: Token | undefined, message: string): never => {
    throw new Error(`prototxt:${token?.line ?? "EOF"}: ${message}${token ? `, got "${token.text}"` : ""}`);
  };

  function parseMessage(path: string, close?: string): ProtoMessage {
    const message: ProtoMessage = {};
    for (;;) {
      const token = peek();
      if (!token) {
        if (close) fail(token, `expected "${close}"`);
        return message;
      }
      if (close && token.kind === "punct" && token.text === close) {
        pos++;
        return message;
      }
      if (token.kind !== "ident") fail(token, "expected a field name");
      pos++;
      const fieldPath = path ? `${path}.${token.text}` : token.text;
      let separator = peek();
      if (separator?.kind === "punct" && separator.text === ":") {
        pos++;
        separator = peek();
      }
      let values: ProtoValue[];
      if (separator?.kind === "punct" && (separator.text === "{" || separator.text === "<")) {
        pos++;
        values = [parseMessage(fieldPath, separator.text === "{" ? "}" : ">")];
      } else if (separator?.kind === "punct" && separator.text === "[") {
        pos++;
        values = [];
        while (!(peek()?.kind === "punct" && peek()!.text === "]")) {
          values.push(parseScalar());
          if (peek()?.kind === "punct" && peek()!.text === ",") pos++;
        }
        pos++;
      } else {
        values = [parseScalar()];
      }
      const existing = message[token.text];
      if (existing !== undefined && !repeated.has(fieldPath)) {
        fail(token, `field "${fieldPath}" is set more than once but is not repeated`);
      }
      message[token.text] = repeated.has(fieldPath)
        ? [...((existing as ProtoValue[] | undefined) ?? []), ...values]
        : values[0]!;
      if (peek()?.kind === "punct" && (peek()!.text === "," || peek()!.text === ";")) pos++;
    }
  }

  function parseScalar(): ProtoValue {
    const token = next();
    if (token.kind === "string") {
      let value = token.value as string;
      while (peek()?.kind === "string") value += next().value as string;
      return value;
    }
    if (token.kind === "number") return token.value as number;
    if (token.kind === "ident") {
      if (token.text === "true") return true;
      if (token.text === "false") return false;
      return token.text;
    }
    return fail(token, "expected a value");
  }

  return parseMessage("");
}
