import { FunctionRouter, cron, schedule } from "@cloudgear/functions";

export class Jobs {
  @schedule(cron`*/5 * * * *`)
  static async tick() {
    return { ticked: true };
  }
}

new FunctionRouter("aws");
