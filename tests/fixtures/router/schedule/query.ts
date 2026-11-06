import { FunctionRouter, cron } from "@cloudgear/functions";

export default async function job(request: { query: Record<string, string> }) {
  return { job: request.query.job };
}

new FunctionRouter("aws").url("GET", "/api/cron", "./query.ts", {
  request: true,
  schedule: [
    { cron: cron`27 7 1 * *`, query: { job: "db-backup" } },
    { cron: cron`41 3 * * *`, query: { job: "db-backup", task: "reshuffle" } },
    cron`0 0 * * *`,
  ],
});
