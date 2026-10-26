import { FunctionRouter, cron, schedule } from "@cloudgear/functions";

export class Jobs {
  @schedule(cron`0 3 * * *`)
  static async run() {
    return {};
  }
}

new FunctionRouter("aws").url("GET", "/run", Jobs.run, { schedule: cron`0 4 * * *` });
