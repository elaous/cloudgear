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
  outDir: string;
}

export interface BundleResult {
  file: string;
  sha256: string;
}

const ADAPTERS: Record<string, string> = { aws: "@cloudgear/functions/drivers/aws" };

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
  fs.writeFileSync(
    entry,
    [
      `import { createHandler } from ${JSON.stringify(adapterPath)};`,
      ...(req.member
        ? [
            `import { ${req.exportName} as root } from ${JSON.stringify(source)};`,
            `const fn = root[${JSON.stringify(req.member)}].bind(root);`,
          ]
        : [`import { ${req.exportName} as fn } from ${JSON.stringify(source)};`]),
      `export const handler = createHandler(fn, ${JSON.stringify(req.routes)});`,
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
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(fs.readFileSync(file));
  return { file, sha256: hasher.digest("hex") };
}
