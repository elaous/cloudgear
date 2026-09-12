#!/usr/bin/env bun
// CLI entrypoint: cloudgear <source-file.ts> [outDir]
// Parses the given file for resource shorthand declarations and writes
// generated-stack.ts + resources.toml into outDir (default: cwd).
import path from "node:path";
import { generateInfraFiles, parseAstForResources } from "./generator";

async function main() {
  const [sourceFileArg, outDirArg] = process.argv.slice(2);
  if (!sourceFileArg) {
    console.error("Usage: cloudgear <source-file.ts> [outDir]");
    process.exit(1);
  }

  const sourceFilePath = path.resolve(process.cwd(), sourceFileArg);
  const outDir = outDirArg ? path.resolve(process.cwd(), outDirArg) : process.cwd();

  const resources = await parseAstForResources(sourceFilePath);
  if (!resources.length) {
    console.error(`No resource declarations found in ${sourceFilePath}`);
    process.exit(1);
  }

  await generateInfraFiles(resources, outDir);
  console.log(
    `cloudgear: generated ${resources.length} resource(s) -> ${path.join(outDir, "generated-stack.ts")}, ${path.join(outDir, "resources.toml")}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
