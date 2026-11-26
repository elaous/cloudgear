import { describeSiteDiff, diffSite, readManifest, readSiteFiles, SITE_MANIFEST } from "./aws/s3site";
import type { PlannedAction } from "./plan";

// Adds each site bucket's file changes to the plan, turning an unchanged bucket into an update when its files differ.
export function withSiteChanges(actions: PlannedAction[], siteRoot: string): PlannedAction[] {
  return actions.map((action) => {
    if (action.type !== "@aws.S3" || !action.desired || action.current?.imported) return action;
    if (action.op !== "create" && action.op !== "update" && action.op !== "noop") return action;
    const options = action.desired.spec.options as Record<string, string> | undefined;
    const manifest = readManifest(action.current?.outputs[SITE_MANIFEST]);
    if (!options?.site_dir && Object.keys(manifest).length === 0) return action;
    const diff = diffSite(readSiteFiles(options, siteRoot), manifest);
    const prune = options?.site_prune === "true";
    const differs = diff.added.length + diff.changed.length > 0 || (prune && diff.removed.length > 0);
    if (!differs && action.op === "noop") return action;
    const changes = [...action.changes, describeSiteDiff(diff, prune)];
    return { ...action, op: action.op === "noop" ? "update" : action.op, changes };
  });
}
