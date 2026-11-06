import { FunctionRouter } from "@cloudgear/functions";

export async function api(name: string) {
  const a = process.env[name];
  const b = Object.keys(process.env);
  return { a, b, c: process.env.FIXED };
}

new FunctionRouter("aws").url("GET", "/api", api);
