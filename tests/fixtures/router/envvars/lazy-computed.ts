import { FunctionRouter } from "@cloudgear/functions";

export async function api(name: string) {
  return (await import(name)).default();
}

new FunctionRouter("aws").url("GET", "/api", api);
