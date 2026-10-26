import { BlobStore, permissions, policy } from "@cloudgear/blob";
import { FunctionRouter, cron, schedule } from "@cloudgear/functions";

const archive = new BlobStore("aws", "://archive");

export class Jobs {
  @schedule(cron`0 3 * * *`)
  @policy(archive, { permissions: [permissions.Put] })
  static async nightly() {
    await archive.put("nightly", "done");
    return {};
  }

  @schedule(cron`30 2 1 * *`)
  @schedule(cron`30 2 15 * *`)
  static async twiceMonthly() {
    return {};
  }
}

export async function ping() {
  return {};
}

new FunctionRouter("aws").url("GET", "/ping", ping);
