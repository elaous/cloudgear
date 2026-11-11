import fs from "node:fs";
import { decodeConfig, type AttachedOriginSpec } from "./config/schema";
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

// Origins found on imported distributions go into the config, so later plans keep them.
export function syncAttached(configPath: string, state: State): string[] {
  const text = fs.readFileSync(configPath, "utf8");
  const config = decodeConfig(text);
  const lines = text.split("\n");
  const messages: string[] = [];
  for (const entry of Object.values(state.entries)) {
    if (entry.type !== "@aws.CloudFront") continue;
    const attached = (entry.spec as { attached?: AttachedOriginSpec[] }).attached;
    if (!attached?.length) continue;
    const isCdn = config.cdn.find((c) => c.domain === entry.name);
    const isApi = config.api?.via === "cloudfront" && config.api.domain === entry.name ? config.api : undefined;
    const target = isCdn ?? isApi;
    if (!target || target.attached?.length) continue;
    if (insertAttached(lines, isCdn ? "cdn" : "api", entry.name, attached)) messages.push(`${entry.name}: kept ${attached.length} attached origin(s) in ${configPath}`);
  }
  if (!messages.length) return messages;
  const next = lines.join("\n");
  fs.writeFileSync(configPath, next);
  const reportFile = envReportPath(configPath);
  const report = readEnvReport(reportFile);
  if (report && report.config === configHash(text)) fs.writeFileSync(reportFile, `${JSON.stringify({ ...report, config: configHash(next) }, null, 2)}\n`);
  return messages;
}
