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
  // Slash-separated path relative to the directory.
  key: string;
  path: string;
  size: number;
  md5: string;
  sha256: string;
  contentType: string;
  cacheControl?: string;
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  zip: "application/zip",
};

export const contentTypeOf = (key: string): string => TYPES[path.extname(key).slice(1).toLowerCase()] ?? "application/octet-stream";

const matches = (patterns: readonly string[], key: string): boolean => patterns.some((pattern) => new Bun.Glob(pattern).match(key));

// Walks the directory once, skipping excluded trees; a symbolic link is an error only if it would be uploaded.
function walk(dir: string, prefix: string, rules: SiteRules, out: { key: string; file: string }[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const file = path.join(dir, entry.name);
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    const excluded = matches(rules.exclude, key) || matches(rules.exclude, `${key}/_`);
    if (entry.isSymbolicLink()) {
      if (!excluded && (rules.include.length === 0 || matches(rules.include, key))) throw new Error(`${file} is a symbolic link; the site directory must hold real files`);
      continue;
    }
    if (entry.isDirectory()) {
      if (!matches(rules.exclude, `${key}/_`)) walk(file, key, rules, out);
    } else if (entry.isFile() && !matches(rules.exclude, key) && (rules.include.length === 0 || matches(rules.include, key))) {
      out.push({ key, file });
      if (out.length > MAX_SITE_FILES) throw new Error(`the site holds more than ${MAX_SITE_FILES} files; narrow it with include and exclude`);
    }
  }
}

// Lists the files a site uploads, in key order, with hashes and headers.
export function listSiteFiles(dir: string, rules: SiteRules): SiteFile[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`site directory ${dir} does not exist; build the site first`);
  const found: { key: string; file: string }[] = [];
  walk(dir, "", rules, found);
  return found.map(({ key, file }): SiteFile => {
    const bytes = fs.readFileSync(file);
    const rule = rules.cacheControl.find((r) => new Bun.Glob(r.match).match(key));
    return {
      key,
      path: file,
      size: bytes.byteLength,
      md5: createHash("md5").update(bytes).digest("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentType: contentTypeOf(key),
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
