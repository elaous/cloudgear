import { FunctionRouter, cron, schedule } from "@cloudgear/functions";
export class Jobs {
  @schedule(cron`0 3 * * *`)
  async run() {
    return {};
  }
}

export async function f() {
  return {};
}

new FunctionRouter("aws").url("GET", "/f", f);
