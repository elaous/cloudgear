import { FunctionRouter, cron, schedule } from "@cloudgear/functions";

export class Jobs {
  @schedule(cron`0 3 * * *`)
  static async nightly() {
    return {};
  }
}

new FunctionRouter("gcp");
