import { FunctionRouter } from "@cloudgear/functions";

export async function api() {
  const rate = Number(process.env.RATE) || 0;
  const level = parseInt(process.env.LEVEL ?? "1");
  const flag = Boolean(process.env.FLAG);
  const dsn = { dsn: process.env.SENTRY_DSN };
  const needed = Number(process.env.NEEDED);
  return { rate, level, flag, dsn, needed };
}

new FunctionRouter("aws", { optionalEnv: ["SENTRY_DSN"] }).url("GET", "/api", api);
