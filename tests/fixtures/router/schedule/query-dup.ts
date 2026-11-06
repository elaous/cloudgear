import { FunctionRouter, cron } from "@cloudgear/functions";

export default async function () {
  return {};
}

new FunctionRouter("aws").url("GET", "/x", "./query-dup.ts", {
  schedule: { cron: cron`0 0 * * *`, query: { job: "a", job: "b" } },
});
