import { createHash } from "node:crypto";
import fs from "node:fs";

export const configHash = (text: string): string => createHash("sha256").update(text).digest("hex");

// How a variable reaches the function: set by cloudgear, by the platform, from a secret, or not at all.
export type EnvSource = "resource" | "option" | "secret" | "secret-wildcard" | "platform" | null;

export interface EnvReportFunction {
  routes: string[];
  variables: Record<string, { required: boolean; files: string[]; provided: EnvSource }>;
  // Reads of the environment that cannot be listed, as file:line.
  dynamic: string[];
}

export interface EnvReport {
  version: 1;
  // sha256 of the config the report was made with.
  config: string;
  functions: Record<string, EnvReportFunction>;
}

// `cloudgear.prototxt` has its report in `cloudgear.env.json`, beside it.
export const envReportPath = (configPath: string): string => `${configPath.replace(/\.prototxt$/, "")}.env.json`;

export function readEnvReport(file: string): EnvReport | undefined {
  if (!fs.existsSync(file)) return undefined;
  let report: EnvReport;
  try {
    report = JSON.parse(fs.readFileSync(file, "utf8")) as EnvReport;
  } catch {
    throw new Error(`${file} is not valid JSON; re-run \`cloudgear generate\``);
  }
  if (report.version !== 1 || typeof report.functions !== "object") throw new Error(`${file} is not an environment report this cloudgear understands; re-run \`cloudgear generate\``);
  return report;
}

export interface MissingEnv {
  function: string;
  variable: string;
  files: string[];
}

// Variables the code needs that nothing provides.
export function missingEnv(report: EnvReport): MissingEnv[] {
  return Object.entries(report.functions).flatMap(([name, fn]) =>
    Object.entries(fn.variables)
      .filter(([, use]) => use.required && use.provided === null)
      .map(([variable, use]) => ({ function: name, variable, files: use.files })),
  );
}

export function formatMissingEnv(missing: MissingEnv[]): string {
  const byFunction = new Map<string, MissingEnv[]>();
  for (const item of missing) byFunction.set(item.function, [...(byFunction.get(item.function) ?? []), item]);
  const lines = [...byFunction].map(([name, items]) => `  ${name}: ${items.map((i) => `${i.variable} (${i.files.join(", ")})`).join(", ")}`);
  return [
    "The code reads environment variables that nothing provides:",
    ...lines,
    "Provide each with a secret (env: store.path(\"/app\")([\"NAME\"])), a functionOptions \"env.NAME\" literal, or read it with a fallback (?? or ||) if it is optional.",
  ].join("\n");
}
