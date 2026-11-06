import { FunctionRouter } from "@cloudgear/functions";
import { EventBus } from "@cloudgear/events";

const jobs = new EventBus("aws", { name: "jobs" });

export async function again() {
  await jobs.publish("job.done", {});
  return {};
}

new FunctionRouter("aws").url("POST", "/again", again, { on: jobs.event("job.done") });
