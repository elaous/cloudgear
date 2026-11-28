// Runs `generate` on every fixture and example setup with a fixed environment and records the outcome.
// Usage: bun scripts/oracle-corpus.ts [out.json] [path-filter]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generate } from "../src/generate";

const repo = path.resolve(import.meta.dir, "..");
const roots = [path.join(repo, "tests/fixtures"), path.join(repo, "examples")];
const files: string[] = [];
const walk = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".cloudgear"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(full);
  }
};
for (const root of roots) walk(root);

const text = new Map(files.map((file) => [file, fs.readFileSync(file, "utf8")]));
const importedBy = new Set<string>();
for (const [file, source] of text) {
  for (const match of source.matchAll(/(?:from|import)\s+["'](\.[^"']*|server\/[^"']*)["']/g)) {
    const specifier = match[1]!;
    const base = specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : path.resolve(repo, "examples/router-app", specifier);
    for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) if (text.has(candidate)) importedBy.add(candidate);
  }
}

interface Row {
  file: string;
  kind: "entry" | "imported by another file" | "no declaration" | "polymorph file";
  readsEnv: boolean;
  status: "ok" | "error";
  error?: string;
  warnings?: number;
  functions?: number;
}

const out = process.argv[2] ?? path.join(os.tmpdir(), "oracle-corpus.json");
const filter = process.argv[3];
const declares = /new\s+(FunctionRouter|BlobStore|BlobStoreWebSite|Cache|Database|CDN|Cert|DNS|EventBus|Registry|Stream|Instance|SecretStore|Policy)\b/;
const rows: Row[] = [];
for (const file of files) {
  const relative = path.relative(repo, file);
  if (filter && !relative.includes(filter)) continue;
  const source = text.get(file)!;
  const kind: Row["kind"] = relative.startsWith("tests/fixtures/polymorph/") ? "polymorph file" : importedBy.has(file) ? "imported by another file" : declares.test(source) ? "entry" : "no declaration";
  const readsEnv = /process\.env|import\.meta\.env|Bun\.env/.test(source);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-"));
  try {
    const result = await generate({ entry: file, configPath: path.join(tmp, "cloudgear.prototxt"), buildDir: path.join(tmp, "build"), project: "oracle", setupEnv: {}, localEnvPath: path.join(tmp, "local.env") });
    rows.push({ file: relative, kind, readsEnv, status: "ok", warnings: result.warnings.length, functions: result.config.function.length });
  } catch (err) {
    const first = String((err as Error).message).split("\n")[0]!;
    rows.push({ file: relative, kind, readsEnv, status: "error", error: first.replaceAll(repo, "<repo>").slice(0, 140) });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
fs.writeFileSync(out, `${JSON.stringify(rows, null, 1)}\n`);
const count = new Map<string, number>();
for (const row of rows) count.set(`${row.kind} / ${row.status}`, (count.get(`${row.kind} / ${row.status}`) ?? 0) + 1);
console.log(`${rows.length} files`);
for (const [key, value] of [...count].sort()) console.log(`${String(value).padStart(5)}  ${key}`);
console.log(`${String(rows.filter((r) => r.readsEnv).length).padStart(5)}  read the environment`);
console.log(`${String(rows.filter((r) => r.warnings).length).padStart(5)}  succeeded with warnings`);
