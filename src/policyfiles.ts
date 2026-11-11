import fs from "node:fs";
import path from "node:path";

export interface PolicyFile {
  path: string;
  content: string;
}

// The files to write under `dir`, checked as a whole: one that would land outside it is an error before anything is written,
// and the same file produced twice (functions sharing a role) is written once.
export function planPolicyFiles(dir: string, files: PolicyFile[]): { target: string; content: string }[] {
  const root = path.resolve(dir);
  const planned = new Map<string, string>();
  for (const file of files) {
    const target = path.resolve(root, file.path);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`Refusing to write "${file.path}" outside ${dir}`);
    if (planned.has(target) && planned.get(target) !== file.content) throw new Error(`Two different policies would be written to ${path.relative(process.cwd(), target)}`);
    planned.set(target, file.content);
  }
  return [...planned].map(([target, content]) => ({ target, content }));
}

// Writes them, saying for each whether it is new, changed or the same as what was there.
export function writePolicyFiles(dir: string | undefined, files: PolicyFile[], log: (line: string) => void = console.log): void {
  if (!dir) return;
  if (!files.length) {
    log("cloudgear: no policies were exported (only the role of an imported function has any)");
    return;
  }
  const planned = planPolicyFiles(dir, files);
  for (const { target, content } of planned) {
    const shown = path.relative(process.cwd(), target);
    const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined;
    if (before === content) {
      log(`cloudgear: ${shown} is unchanged`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    log(`cloudgear: ${before === undefined ? "wrote" : "overwrote"} ${shown}`);
  }
}
