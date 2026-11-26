import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_SITE_FILES = 10_000;

export interface SiteRules {
  include: readonly string[];
  exclude: readonly string[];
  cacheControl: readonly { match: string; value: string }[];
}

export interface SiteFile {
  // Slash-separated path relative to the directory; the object key without the bucket path.
  key: string;
  path: string;
  size: number;
  md5: string;
  sha256: string;
  contentType: string;
  cacheControl?: string;
}

const matches = (patterns: readonly string[], key: string): boolean => patterns.some((pattern) => new Bun.Glob(pattern).match(key));

function walk(dir: string, prefix: string, out: { key: string; file: string }[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = path.join(dir, entry.name);
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`${file} is a symbolic link; the site directory must hold real files`);
    if (entry.isDirectory()) walk(file, key, out);
    else if (entry.isFile()) out.push({ key, file });
    if (out.length > MAX_SITE_FILES) throw new Error(`the site directory holds more than ${MAX_SITE_FILES} files; narrow it with include and exclude`);
  }
}

// Lists the files a site uploads, in key order, with hashes and headers.
export function listSiteFiles(dir: string, rules: SiteRules): SiteFile[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`site directory ${dir} does not exist; build the site first`);
  const found: { key: string; file: string }[] = [];
  walk(dir, "", found);
  return found
    .filter(({ key }) => (rules.include.length === 0 || matches(rules.include, key)) && !matches(rules.exclude, key))
    .map(({ key, file }): SiteFile => {
      const bytes = fs.readFileSync(file);
      const rule = rules.cacheControl.find((r) => new Bun.Glob(r.match).match(key));
      return {
        key,
        path: file,
        size: bytes.byteLength,
        md5: createHash("md5").update(bytes).digest("hex"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contentType: Bun.file(file).type || "application/octet-stream",
        ...(rule ? { cacheControl: rule.value } : {}),
      };
    });
}

// Changes when a file's name, content, type or headers change.
export function siteFilesHash(files: readonly SiteFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.key}\0${file.sha256}\0${file.contentType}\0${file.cacheControl ?? ""}\n`);
  return hash.digest("hex");
}
