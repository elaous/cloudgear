import { FunctionRouter, cron, schedule } from "@cloudgear/functions";

class Jobs {
  @schedule(cron`0 3 * * *`)
  async tick() {
    return {};
  }
}

export const jobs = new Jobs();

new FunctionRouter("aws").url("GET", "/tick", jobs.tick);
