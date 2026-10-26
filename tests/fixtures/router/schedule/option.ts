import { FunctionRouter, cron } from "@cloudgear/functions";

export async function report() {
  return {};
}
export async function health() {
  return {};
}

new FunctionRouter("aws")
  .url("GET", "/report", report, { schedule: [cron`*/15 * * * *`, cron`0 9 * * 1-5`] })
  .url("POST", "/report", report, { name: "postReport", schedule: cron`*/15 * * * *` })
  .url("GET", "/health", health);
