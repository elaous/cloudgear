import { FunctionRouter, cron } from "@cloudgear/functions";

export default async function () {
  return {};
}

new FunctionRouter("aws").url("GET", "/x", "./query-forms.ts", {
  schedule: [
    { cron: cron`0 0 * * *`, query: { a: "1", b: "2" } },
    { cron: cron`0 0 * * *`, query: { b: "2", a: "1" } },
    { cron: cron`0 0 * * *`, query: { a: "other" } },
    { cron: cron`0 1 * * *`, query: {} },
    { cron: cron`0 2 * * *`, query: { flag: "" } },
  ],
});
