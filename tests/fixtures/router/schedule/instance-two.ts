import { FunctionRouter, cron, schedule } from "@cloudgear/functions";

export class Jobs {
  @schedule(cron`*/5 * * * *`)
  async tick() {
    return {};
  }
}

export const first = new Jobs();
export const second = new Jobs();

new FunctionRouter("aws");
