import fs from "node:fs";
import { decodeConfig, type AttachedOriginSpec, type CloudgearConfig } from "./config/schema";
import { encodePrototxt, type ProtoMessage } from "./config/prototxt";
import type { State } from "./deploy/state";
import { configHash, envReportPath, readEnvReport } from "./envreport";

// Adds the attached blocks at the end of the cdn or api block of the domain.
function insertAttached(lines: string[], kind: "cdn" | "api", domain: string, attached: AttachedOriginSpec[]): boolean {
  const wanted = `  ${encodePrototxt({ domain } as ProtoMessage, []).trim()}`;
  for (let start = 0; start < lines.length; start++) {
    if (lines[start] !== `${kind} {`) continue;
    let end = start + 1;
    while (end < lines.length && lines[end] !== "}") end++;
    if (!lines.slice(start, end).includes(wanted)) continue;
    const block = encodePrototxt({ attached } as unknown as ProtoMessage, []).trimEnd().split("\n").map((line) => `  ${line}`);
    lines.splice(end, 0, ...block);
    return true;
  }
  return false;
}

export interface AttachedSync {
  written: string[];
  // Origins that could not be written into the config; apply would drop them.
  problems: string[];
}

// Origins found on imported distributions go into the config, so later plans keep them.
export function syncAttached(configPath: string, state: State): AttachedSync {
  const result: AttachedSync = { written: [], problems: [] };
  const text = fs.readFileSync(configPath, "utf8");
  let config: CloudgearConfig;
  try {
    config = decodeConfig(text);
  } catch (err) {
    result.problems.push(`${configPath} could not be read to add the attached origins (${(err as Error).message})`);
    return result;
  }
  const lines = text.split("\n");
  for (const entry of Object.values(state.entries)) {
    if (entry.type !== "@aws.CloudFront") continue;
    const attached = (entry.spec as { attached?: AttachedOriginSpec[] }).attached;
    if (!attached?.length) continue;
    const isCdn = config.cdn.find((c) => c.domain === entry.name);
    const isApi = config.api?.via === "cloudfront" && config.api.domain === entry.name ? config.api : undefined;
    const target = isCdn ?? isApi;
    if (!target) continue;
    if (target.attached?.length) {
      const have = new Set(target.attached.map((item) => item.id));
      const dropped = attached.filter((item) => !have.has(item.id)).map((item) => item.id);
      if (dropped.length) result.problems.push(`${entry.name}: the config already lists attached origins, so ${dropped.join(", ")} will be removed by apply; add them to the config to keep them`);
      continue;
    }
    if (insertAttached(lines, isCdn ? "cdn" : "api", entry.name, attached)) result.written.push(`${entry.name}: kept ${attached.length} attached origin(s) in ${configPath}`);
    else result.problems.push(`${entry.name}: the attached origin(s) ${attached.map((item) => item.id).join(", ")} could not be added to ${configPath}, whose ${isCdn ? "cdn" : "api"} block is not in the generated layout; run \`cloudgear generate\` and import again, or apply will remove them`);
  }
  if (!result.written.length) return result;
  const next = lines.join("\n");
  fs.writeFileSync(configPath, next);
  const reportFile = envReportPath(configPath);
  const report = readEnvReport(reportFile);
  if (report && report.config === configHash(text)) fs.writeFileSync(reportFile, `${JSON.stringify({ ...report, config: configHash(next) }, null, 2)}\n`);
  return result;
}
