import fs from "node:fs";
import path from "node:path";

export interface BundleRequest {
  name: string;
  sourceFile: string;
  exportName: string;
  member?: string;
  routes: { method: string; path: string }[];
  provider: string;
  // Trusts caller identity in router calls; off for public URLs.
  trustContext: boolean;
  jwt?: { settings: Record<string, unknown>; anonymous: boolean };
  include?: { rel: string; abs: string }[];
  passRequest?: boolean;
  responseKind?: "helper" | "writer";
  secrets?: { bindings: Record<string, unknown>[]; services: string[] };
  outDir: string;
}

export interface BundleResult {
  file: string;
  sha256: string;
}

export const INCLUDED_DIR = "files";

// Included file path, kept inside the files directory.
export function includedPath(filesDir: string, rel: string): string {
  const resolved = path.resolve(filesDir, rel);
  const within = path.relative(filesDir, resolved);
  if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error(`Included file "${rel}" is outside the function's files`);
  }
  return resolved;
}

export function hashContents(index: Uint8Array, files: { rel: string; data: Uint8Array }[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(index);
  for (const { rel, data } of [...files].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    hasher.update(`\0${rel}\0`);
    hasher.update(data);
  }
  return hasher.digest("hex");
}

export function hashBundle(file: string, filesDir: string, rels: string[]): string {
  return hashContents(fs.readFileSync(file), rels.map((rel) => ({ rel, data: fs.readFileSync(includedPath(filesDir, rel)) })));
}

const DRIVER_FACTORIES: Record<string, { name: string }> = {
  ssm: { name: "createSsmDriver" },
  secretsmanager: { name: "createSecretsManagerDriver" },
};

const ADAPTERS: Record<string, string> = {
  aws: "@cloudgear/functions/drivers/aws",
  gcp: "@cloudgear/functions/drivers/gcp",
};

export async function bundleFunction(req: BundleRequest): Promise<BundleResult> {
  const adapter = ADAPTERS[req.provider];
  if (!adapter) throw new Error(`No function adapter for provider "${req.provider}"`);

  const dir = path.join(req.outDir, req.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const entry = path.join(dir, "entry.ts");
  const source = path.resolve(req.sourceFile);
  // Resolved from the app; build dir may sit outside node_modules.
  const adapterPath = Bun.resolveSync(adapter, path.dirname(source));
  const authPath = req.jwt ? Bun.resolveSync("@cloudgear/functions/auth", path.dirname(source)) : "";
  const handlerOptions = `{ trustContext: ${req.trustContext}${
    req.jwt ? `, authenticate: jwtAuth(${JSON.stringify(req.jwt.settings)}), anonymous: ${req.jwt.anonymous}` : ""
  }${req.passRequest ? ", request: true" : ""}${req.responseKind ? `, response: ${JSON.stringify(req.responseKind)}` : ""}${req.secrets ? ", prepare" : ""} }`;
  const secretServices = req.secrets?.services ?? [];
  fs.writeFileSync(
    entry,
    [
      `import { createHandler } from ${JSON.stringify(adapterPath)};`,
      ...(req.jwt ? [`import { jwtAuth } from ${JSON.stringify(authPath)};`] : []),
      ...(req.secrets
        ? [
            `import { secretsLoader } from ${JSON.stringify(Bun.resolveSync("@cloudgear/secrets", path.dirname(source)))};`,
            ...secretServices.map((service) => `import { ${DRIVER_FACTORIES[service]!.name} } from ${JSON.stringify(Bun.resolveSync(`@cloudgear/secrets/drivers/${service}`, path.dirname(source)))};`),
            `const prepare = secretsLoader(${JSON.stringify(req.secrets.bindings)}, { ${secretServices.map((service) => `${service}: ${DRIVER_FACTORIES[service]!.name}`).join(", ")} });`,
          ]
        : []),
      ...(req.member
        ? [
            `import { ${req.exportName} as root } from ${JSON.stringify(source)};`,
            `const fn = root[${JSON.stringify(req.member)}].bind(root);`,
          ]
        : [`import { ${req.exportName} as fn } from ${JSON.stringify(source)};`]),
      `export const handler = createHandler(fn, ${JSON.stringify(req.routes)}, ${handlerOptions});`,
      "",
    ].join("\n"),
  );

  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [entry],
      outdir: dir,
      naming: "index.mjs",
      target: "node",
      format: "esm",
      minify: true,
    });
  } catch (err) {
    throw new Error(`Bundling "${req.name}" failed:\n${describeBuildFailure(err)}`, { cause: err });
  }
  if (!result.success) {
    const errors = result.logs.filter((log) => log.level === "error");
    throw new Error(`Bundling "${req.name}" failed:\n${describeBuildFailure(new AggregateError(errors.length ? errors : result.logs, "Bundle failed"))}`);
  }

  const file = path.join(dir, "index.mjs");
  const filesDir = path.join(dir, INCLUDED_DIR);
  for (const included of req.include ?? []) {
    const target = path.join(filesDir, included.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(included.abs, target);
  }
  return { file, sha256: hashBundle(file, filesDir, (req.include ?? []).map((f) => f.rel)) };
}

const MAX_CAUSES = 20;

// Bun.build's error message is generic; causes are in `errors`.
export function describeBuildFailure(err: unknown): string {
  const causes = err instanceof AggregateError && err.errors.length ? err.errors : [err];
  const lines = causes.map((cause) => {
    const detail = (cause ?? {}) as { message?: string; position?: { file?: string; line?: number } | null };
    const where = detail.position?.file ? ` (${detail.position.file}${detail.position.line ? `:${detail.position.line}` : ""})` : "";
    return `${detail.message ?? String(cause)}${where}`;
  });
  const unique = [...new Set(lines)];
  const shown = unique.slice(0, MAX_CAUSES);
  if (unique.length > shown.length) shown.push(`... and ${unique.length - shown.length} more`);
  // Relative "generated" imports are made by the project build step.
  if (unique.some((line) => /Could not resolve: "\.{1,2}\/[^"]*\bgenerated\b/.test(line))) {
    shown.push("A file with \"generated\" in its name is usually made by a build step of yours; run that step before `cloudgear generate`.");
  }
  return shown.join("\n");
}
