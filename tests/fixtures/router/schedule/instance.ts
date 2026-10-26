import { FunctionRouter, cron, schedule } from "@cloudgear/functions";

export class Jobs {
  private runs = 0;

  @schedule(cron`*/5 * * * *`)
  async tick() {
    this.runs += 1;
    return { runs: this.runs };
  }
}

export const jobs = new Jobs();

new FunctionRouter("aws");
