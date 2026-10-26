import { FunctionRouter, cron } from "@cloudgear/functions";

export async function f() {
  return {};
}

const options = { schedule: cron`0 3 * * *` };
new FunctionRouter("aws").url("GET", "/f", f, options);
