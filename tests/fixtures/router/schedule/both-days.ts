import { FunctionRouter, cron, schedule } from "@cloudgear/functions";

export async function f() {
  return {};
}

new FunctionRouter("aws").url("GET", "/f", f, { schedule: cron`0 0 1 * 1` });
