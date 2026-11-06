import { FunctionRouter } from "@cloudgear/functions";
import { EventBus, on } from "@cloudgear/events";

const bus = new EventBus("aws", { name: "jobs" });

export class Worker {
  @on(bus.event("job.queued"))
  static async run(job: unknown) {
    return job;
  }
}

new FunctionRouter("aws");
