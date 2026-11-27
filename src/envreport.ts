export type EnvSource = "resource" | "option" | "secret" | "secret-wildcard" | "platform" | null;

export interface EnvReportFunction {
  routes: string[];
  variables: Record<string, { required: boolean; files: string[]; provided: EnvSource }>;
  dynamic: string[];
}

export interface EnvReport {
  functions: Record<string, EnvReportFunction>;
}

export interface MissingEnv {
  function: string;
  variable: string;
  files: string[];
}

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
