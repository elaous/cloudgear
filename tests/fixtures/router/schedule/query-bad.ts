import { FunctionRouter, cron } from "@cloudgear/functions";

export default async function job() {
  return {};
}

new FunctionRouter("aws").url("GET", "/api/cron", "./query-bad.ts", {
  request: true,
  schedule: { cron: cron`0 0 * * *`, query: { job: "a b&c" } },
});
