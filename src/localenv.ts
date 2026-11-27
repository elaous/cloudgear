import fs from "node:fs";
import path from "node:path";
import type { EnvReport } from "./envreport";

const HEADER = "# Added by `cloudgear generate`: variables the functions read. Values stay yours.";

export interface LocalEnvUpdate {
  file: string;
  created: boolean;
  added: string[];
  // Names that are not valid dotenv keys.
  skipped: string[];
}

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// What a developer sets locally: everything the code reads except what the platform or cloudgear sets.
export function localVariables(report: EnvReport): { required: string[]; optional: string[] } {
  const required = new Set<string>();
  const optional = new Set<string>();
  for (const fn of Object.values(report.functions)) {
    for (const [name, use] of Object.entries(fn.variables)) {
      if (use.provided === "platform" || use.provided === "resource") continue;
      (use.required ? required : optional).add(name);
    }
  }
  for (const name of required) optional.delete(name);
  return { required: [...required].sort(), optional: [...optional].sort() };
}

const escaped = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const declares = (text: string, name: string): boolean => new RegExp(`^[ \\t]*(?:#[ \\t]*)?(?:export[ \\t]+)?${escaped(name)}[ \\t]*=`, "m").test(text);

// Appends the names the file lacks, required ones as `NAME=` and optional ones commented out; existing lines stay.
export function updateLocalEnv(file: string, report: EnvReport): LocalEnvUpdate {
  if (fs.existsSync(file) && !fs.statSync(file).isFile()) throw new Error(`${file} is not a file`);
  const exists = fs.existsSync(file);
  const text = (exists ? fs.readFileSync(file, "utf8") : "").replace(/^\uFEFF/, "");
  const wanted = localVariables(report);
  const skipped = [...wanted.required, ...wanted.optional].filter((name) => !VALID_NAME.test(name));
  const required = wanted.required.filter((name) => VALID_NAME.test(name) && !declares(text, name));
  const optional = wanted.optional.filter((name) => VALID_NAME.test(name) && !declares(text, name));
  const added = [...required, ...optional];
  if (!added.length) return { file, created: false, added, skipped };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = [...(text.includes(HEADER) ? [] : [HEADER]), ...required.map((name) => `${name}=`), ...optional.map((name) => `# ${name}=`)];
  const separator = text === "" ? "" : /\n$/.test(text) ? eol : eol + eol;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bom = exists && fs.readFileSync(file, "utf8").startsWith("\uFEFF") ? "\uFEFF" : "";
  fs.writeFileSync(file, `${bom}${text}${separator}${lines.join(eol)}${eol}`, { mode: 0o600 });
  return { file, created: !exists, added, skipped };
}
