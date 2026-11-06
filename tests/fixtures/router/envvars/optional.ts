import { FunctionRouter } from "@cloudgear/functions";

export async function api() {
  const rate = Number(process.env.RATE) || 0;
  const level = parseInt(process.env.LEVEL, 10) || 1;
  const nested = Number(String(process.env.NESTED)) || 1;
  const flag = Boolean(process.env.FLAG);
  const dsn = { dsn: process.env.SENTRY_DSN };
  const needed = Number(process.env.NEEDED);
  const stringy = String(process.env.STRINGY) || "d";
  const nullish = Number(process.env.NULLISH) ?? 5;
  const bare = String(process.env.BARE);
  if (!Boolean(process.env.GUARDED)) throw new Error("GUARDED is required");
  return { rate, level, nested, flag, dsn, needed, stringy, nullish, bare };
}

new FunctionRouter("aws", { optionalEnv: ["SENTRY_DSN", "TYPO_NAME"] as const }).url("GET", "/api", api);
