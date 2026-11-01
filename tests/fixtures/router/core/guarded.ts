import { BlobStore } from "@cloudgear/blob";
import { FunctionRouter } from "@cloudgear/functions";
import { claim, guard, permissions, policy } from "@cloudgear/core";

const reports = new BlobStore("aws", "://reports");
const admins = new BlobStore("aws", "://admins");

export class Reports {
  @guard(claim("role", "admin"))
  @policy(reports, { permissions: [permissions.Get] })
  static async read({ id }: { id: string }) {
    return { id, body: await reports.getText(id) };
  }

  @guard(async (_input, context) => admins.exists(context.auth?.subject ?? ""))
  static async audit() {
    return { ok: true };
  }
}

new FunctionRouter("aws")
  .url("GET", "/reports/{id}", Reports.read)
  .url("GET", "/audit", Reports.audit);
