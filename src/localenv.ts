import fs from "node:fs";
import type { EnvReport } from "./envreport";

const HEADER = "# Added by `cloudgear generate`: variables the functions read. Values stay yours.";

export interface LocalEnvUpdate {
  file: string;
  created: boolean;
  added: string[];
}

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
  const exists = fs.existsSync(file);
  const text = exists ? fs.readFileSync(file, "utf8") : "";
  const wanted = localVariables(report);
  const required = wanted.required.filter((name) => !declares(text, name));
  const optional = wanted.optional.filter((name) => !declares(text, name));
  const added = [...required, ...optional];
  if (!added.length) return { file, created: false, added };
  const lines = [...(text.includes(HEADER) ? [] : [HEADER]), ...required.map((name) => `${name}=`), ...optional.map((name) => `# ${name}=`)];
  const separator = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(file, `${text}${separator}${lines.join("\n")}\n`, { mode: 0o600 });
  return { file, created: !exists, added };
}
