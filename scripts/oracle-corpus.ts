// Runs `generate` on every fixture and example setup, from the repository root with a fixed project name and the
// environment the tests give each setup, and records success or the full error message.
// Usage: bun scripts/oracle-corpus.ts [out.json] [path-filter]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generate } from "../src/generate";

const repo = path.resolve(import.meta.dir, "..");
// Error messages embed paths relative to the working directory.
process.chdir(repo);
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
const resolveIn = (file: string, specifier: string): string | undefined => {
  const base = specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : path.resolve(repo, "examples/router-app", specifier);
  return [base, `${base}.ts`, path.join(base, "index.ts")].find((candidate) => text.has(candidate));
};
// Files other files import, and files a router names by path (`.url("GET", "/x", "./api/x.ts")`).
const importedBy = new Set<string>();
const scriptTargets = new Set<string>();
for (const [file, source] of text) {
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']*|server\/[^"']*)["']/g)) {
    const target = resolveIn(file, match[1]!);
    if (target) importedBy.add(target);
  }
  for (const match of source.matchAll(/\.url\([^)]*?["'](\.[^"']*\.tsx?)["']/g)) {
    const target = resolveIn(file, match[1]!);
    if (target) scriptTargets.add(target);
  }
}

// The environment the tests give a setup that reads variables.
const environments: Record<string, Record<string, string>> = {
  "tests/fixtures/router/env-domain.ts": { ENV_DOMAIN: "staging.example.com", ENV_ZONE: "example.com" },
  "tests/fixtures/router/env-forms.ts": { D1: "one.example.com", D2: "two.example.com", D3: "three.example.com", D6: "six.example.com", D7: "zone.example.com", D9: "nine.example.com", BUCKET: "assets", PREFIX: "img" },
  "tests/fixtures/router/network/env.ts": { VPC_ID: "vpc-0abc5678" },
  "tests/fixtures/router/site/ok.ts": { ENV_DOMAIN: "example.com" },
};

interface Row {
  file: string;
  kind: "entry" | "imported by another file" | "script handler" | "type-check only" | "no declaration" | "polymorph file";
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
  const importsDeclaring = [...source.matchAll(/from\s+["'](\.[^"']*)["']/g)].some((m) => {
    const target = resolveIn(file, m[1]!);
    return !!target && declares.test(text.get(target)!);
  });
  const kind: Row["kind"] = relative.startsWith("tests/fixtures/polymorph/")
    ? "polymorph file"
    : relative.startsWith("tests/fixtures/router/types/")
      ? "type-check only"
      : scriptTargets.has(file)
        ? "script handler"
        : importedBy.has(file)
          ? "imported by another file"
          : declares.test(source) || importsDeclaring
            ? "entry"
            : "no declaration";
  const readsEnv = /process\.env|import\.meta\.env|Bun\.env/.test(source);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-"));
  try {
    const result = await generate({ entry: file, configPath: path.join(tmp, "cloudgear.prototxt"), buildDir: path.join(tmp, "build"), project: "oracle", setupEnv: environments[relative] ?? {}, localEnvPath: path.join(tmp, "local.env") });
    rows.push({ file: relative, kind, readsEnv, status: "ok", warnings: result.warnings.length, functions: result.config.function.length });
  } catch (err) {
    rows.push({ file: relative, kind, readsEnv, status: "error", error: String((err as Error).message).replaceAll(repo, "<repo>") });
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
