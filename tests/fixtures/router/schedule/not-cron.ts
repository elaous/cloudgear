import { FunctionRouter, cron, schedule } from "@cloudgear/functions";

export async function f() {
  return {};
}

new FunctionRouter("aws").url("GET", "/f", f, { schedule: "*/5 * * * *" as never });
