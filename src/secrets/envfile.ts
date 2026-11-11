// Errors name the file and line, never a value.
export function parseEnvFile(text: string, file = ".env"): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`${file}:${index + 1}: expected KEY=value`);
    const [, key, rest] = match as unknown as [string, string, string];
    const first = rest[0];
    if (first === '"' || first === "'") {
      let body = rest.slice(1);
      let end = closingQuote(body, first);
      const start = index;
      while (end === -1 && index + 1 < lines.length) {
        body += `\n${lines[++index]!}`;
        end = closingQuote(body, first);
      }
      if (end === -1) throw new Error(`${file}:${start + 1}: the quoted value of ${key} is never closed`);
      const tail = body.slice(end + 1).trim();
      if (tail && !tail.startsWith("#")) throw new Error(`${file}:${start + 1}: unexpected text after the quoted value of ${key}`);
      const quoted = body.slice(0, end);
      values[key] = first === '"' ? unescapeQuoted(quoted) : quoted;
    } else {
      values[key] = rest.replace(/\s+#.*$/, "").trim();
    }
  }
  return values;
}

function closingQuote(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    if (quote === '"' && body[i] === "\\") i++;
    else if (body[i] === quote) return i;
  }
  return -1;
}

function unescapeQuoted(value: string): string {
  return value.replace(/\\([nrt"\\])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" })[c]!);
}
