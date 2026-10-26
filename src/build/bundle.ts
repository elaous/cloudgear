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
  passResponse?: boolean;
  outDir: string;
}

export interface BundleResult {
  file: string;
  // Covers the bundle and the included files.
  sha256: string;
}

export const INCLUDED_DIR = "files";

// Hash of the bundle file and of each included file's path and content, in path order.
export function hashBundle(file: string, filesDir: string, rels: string[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(fs.readFileSync(file));
  for (const rel of [...rels].sort()) {
    hasher.update(`\0${rel}\0`);
    hasher.update(fs.readFileSync(path.join(filesDir, rel)));
  }
  return hasher.digest("hex");
}

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
  }${req.passRequest ? ", request: true" : ""}${req.passResponse ? ", response: true" : ""} }`;
  fs.writeFileSync(
    entry,
    [
      `import { createHandler } from ${JSON.stringify(adapterPath)};`,
      ...(req.jwt ? [`import { jwtAuth } from ${JSON.stringify(authPath)};`] : []),
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
