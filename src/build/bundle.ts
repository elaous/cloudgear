import fs from "node:fs";
import path from "node:path";

export interface BundleRequest {
  name: string;
  sourceFile: string;
  exportName: string;
  // Method name when the routed function lives on the exported object `exportName`.
  member?: string;
  routes: { method: string; path: string }[];
  provider: string;
  // Whether the function trusts the caller identity in router calls. Off when anyone can reach the
  // function (public URLs, or a CDN that forwards viewers' requests straight to it).
  trustContext: boolean;
  // Token verification inside the function (see jwtAuth); `anonymous` functions skip it.
  jwt?: { settings: Record<string, unknown>; anonymous: boolean };
  // Files copied next to the bundle, at their paths from the project root.
  include?: { rel: string; abs: string }[];
  passRequest?: boolean;
  responseKind?: "helper" | "writer";
  // Secrets filled into the environment before the first request, and the services they come from.
  secrets?: { bindings: Record<string, unknown>[]; services: string[] };
  outDir: string;
}

export interface BundleResult {
  file: string;
  // Covers the bundle and the included files.
  sha256: string;
}

export const INCLUDED_DIR = "files";

// Where an included file lives under the files directory; a path from a config MUST stay inside it.
export function includedPath(filesDir: string, rel: string): string {
  const resolved = path.resolve(filesDir, rel);
  const within = path.relative(filesDir, resolved);
  if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error(`Included file "${rel}" is outside the function's files`);
  }
  return resolved;
}

// Hash of the bundle and of each included file's path and content, in path order.
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

// One self-contained ESM file per function: its module, every import it
// reaches and their node_modules, wrapped in the provider's handler adapter.
export async function bundleFunction(req: BundleRequest): Promise<BundleResult> {
  const adapter = ADAPTERS[req.provider];
  if (!adapter) throw new Error(`No function adapter for provider "${req.provider}"`);

  const dir = path.join(req.outDir, req.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const entry = path.join(dir, "entry.ts");
  const source = path.resolve(req.sourceFile);
  // Resolved from the app so the build dir may live outside its node_modules tree.
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

  const result = await Bun.build({
    entrypoints: [entry],
    outdir: dir,
    naming: "index.mjs",
    target: "node",
    format: "esm",
    minify: true,
  });
  if (!result.success) {
    throw new Error(`Bundling "${req.name}" failed:\n${result.logs.map(String).join("\n")}`);
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
