#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

export type Mode = "all" | "targeted" | "none";

export interface TestPlan {
  mode: Mode;
  tests: string[];
  reasons: string[];
}

const SHARED_FRACTION = 0.5;

const RUN_ALL: RegExp[] = [
  /(^|\/)package\.json$/,
  /^bun\.lock$/,
  /^tsconfig[^/]*\.json$/,
  /^scripts\//,
  /^\.github\/workflows\//,
  /^tests\/fixtures\//,
  /^tests\/helpers\.ts$/,
];

const RUN_NOTHING: RegExp[] = [
  /\.md$/,
  /^LICENSE$/,
  /^\.gitignore$/,
  /^\.mcp\.json$/,
  /^biome\.json$/,
  /^\.github\/(ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE|dependabot\.yml$|CODEOWNERS$)/,
];

const IMPORT = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const TEST_FILE = /^tests\/[^/]+\.test\.ts$/;
const SOURCE_DIRS = ["src", "packages", "tests"];

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.name === "node_modules" || entry.name === ".cloudgear" || rel === "tests/fixtures") continue;
    if (entry.isDirectory()) walk(root, rel, out);
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
}

function workspaceEntries(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const pkg of fs.readdirSync(path.join(root, "packages"))) {
    const file = path.join(root, "packages", pkg, "package.json");
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as { name: string; exports?: Record<string, string> };
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      entries.set(path.posix.join(manifest.name, subpath), path.posix.join("packages", pkg, target));
    }
  }
  return entries;
}

function resolveImport(spec: string, from: string, files: Set<string>, workspace: Map<string, string>): string | undefined {
  if (spec.startsWith("@cloudgear/")) return workspace.get(spec);
  if (!spec.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec.replace(/\.(js|ts)$/, "")));
  return [`${base}.ts`, `${base}/index.ts`].find((candidate) => files.has(candidate));
}

export function planTests(changed: string[], root: string = path.resolve(import.meta.dir, "..")): TestPlan {
  const reasons: string[] = [];
  const files: string[] = [];
  for (const dir of SOURCE_DIRS) walk(root, dir, files);
  const known = new Set(files);
  const tests = files.filter((file) => TEST_FILE.test(file));
  const everything = (reason: string): TestPlan => ({ mode: "all", tests: [], reasons: [...reasons, reason] });

  const workspace = workspaceEntries(root);
  const dependents = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (!dependents.has(to)) dependents.set(to, new Set());
    dependents.get(to)?.add(from);
  };
  const sources = new Map<string, string>();
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    sources.set(file, text);
    for (const match of text.matchAll(IMPORT)) {
      const target = resolveImport(match[1] ?? match[2] ?? match[3] ?? "", file, known, workspace);
      if (target) link(file, target);
    }
  }
  const bundlers = ["src/build/bundle.ts", "src/analyze/app.ts"].filter((file) => known.has(file));
  for (const file of files.filter((f) => f.startsWith("packages/"))) for (const bundler of bundlers) link(bundler, file);
  for (const test of tests) if (sources.get(test)?.includes('"cli.ts"') && known.has("src/cli.ts")) link(test, "src/cli.ts");
  const readExamples = tests.filter((file) => sources.get(file)?.includes('"examples"'));

  const affected = new Set<string>();
  const queue: string[] = [];
  for (const file of changed) {
    if (RUN_ALL.some((pattern) => pattern.test(file))) return everything(`${file} affects every test`);
    if (RUN_NOTHING.some((pattern) => pattern.test(file))) {
      reasons.push(`${file}: no tests`);
      continue;
    }
    if (file.startsWith("examples/")) {
      for (const test of readExamples) affected.add(test);
      reasons.push(`${file}: ${readExamples.join(", ") || "no tests"}`);
      continue;
    }
    if (!known.has(file)) return everything(`${file} is not a known source file (deleted, renamed or not TypeScript)`);
    queue.push(file);
  }

  const seen = new Set(queue);
  while (queue.length) {
    const file = queue.pop() as string;
    if (TEST_FILE.test(file)) affected.add(file);
    for (const dependent of dependents.get(file) ?? []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push(dependent);
    }
  }

  if (affected.size > tests.length * SHARED_FRACTION) {
    return everything(`${affected.size} of ${tests.length} test files depend on the change (shared module)`);
  }
  const selected = [...affected].sort();
  return { mode: selected.length ? "targeted" : "none", tests: selected, reasons };
}

function main(): void {
  const args = process.argv.slice(2);
  const explain = args.includes("--explain");
  const names = args.filter((arg) => !arg.startsWith("--"));
  const input = names.length ? names : fs.readFileSync(0, "utf8").split("\n");
  const changed = input.map((line) => line.trim()).filter(Boolean);
  const plan = planTests(changed);
  if (explain) for (const reason of plan.reasons) console.error(reason);
  console.log(`mode=${plan.mode}`);
  console.log(`tests=${plan.tests.join(" ")}`);
}

if (import.meta.main) main();
