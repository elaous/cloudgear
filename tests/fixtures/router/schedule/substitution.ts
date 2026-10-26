import { FunctionRouter, cron, schedule } from "@cloudgear/functions";
const minute = "5";
export async function f() {
  return {};
}

new FunctionRouter("aws").url("GET", "/f", f, { schedule: cron`${minute} * * * *` });
