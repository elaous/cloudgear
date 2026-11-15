import {
  CreateStreamCommand,
  DecreaseStreamRetentionPeriodCommand,
  DeleteStreamCommand,
  DescribeStreamSummaryCommand,
  IncreaseStreamRetentionPeriodCommand,
  UpdateShardCountCommand,
  UpdateStreamModeCommand,
} from "@aws-sdk/client-kinesis";
import { DEFAULT_RETENTION_HOURS, DEFAULT_SHARDS } from "@cloudgear/stream";
import type { Adopted, Driver } from "../apply";
import type { DesiredEntry } from "../plan";
import { destroyAllowed, withoutAllowDestroy } from "../protect";
import type { StateEntry } from "../state";
import type { SendClient } from "./index";
import { tagList, type Tagger } from "./tags";

export interface KinesisDeps {
  kinesis: SendClient;
  tags?: Tagger;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
}

// Only what the config sets; an existing stream keeps everything else.
interface Wanted {
  mode?: "PROVISIONED" | "ON_DEMAND";
  shards?: number;
  retentionHours?: number;
}

interface Summary {
  StreamARN?: string;
  StreamStatus?: string;
  StreamModeDetails?: { StreamMode?: string };
  OpenShardCount?: number;
  RetentionPeriodHours?: number;
}

const ACTIVE_ATTEMPTS = 60;
const ACTIVE_WAIT_MS = 5000;

function wanted(spec: Record<string, unknown>): Wanted {
  const options = (spec.options ?? {}) as Record<string, string>;
  return {
    ...(options.mode ? { mode: options.mode === "on-demand" ? ("ON_DEMAND" as const) : ("PROVISIONED" as const) } : {}),
    ...(options.shards ? { shards: Number(options.shards) } : {}),
    ...(options.retention_hours ? { retentionHours: Number(options.retention_hours) } : {}),
  };
}

const modeOf = (summary: Summary): string => summary.StreamModeDetails?.StreamMode ?? "PROVISIONED";

function differences(summary: Summary, want: Wanted): string[] {
  return [
    ...(want.mode && modeOf(summary) !== want.mode ? [`mode is ${modeOf(summary).toLowerCase().replace("_", "-")} (config: ${want.mode.toLowerCase().replace("_", "-")})`] : []),
    ...(want.shards !== undefined && (want.mode ?? modeOf(summary)) === "PROVISIONED" && summary.OpenShardCount !== want.shards ? [`${summary.OpenShardCount} shards (config: ${want.shards})`] : []),
    ...(want.retentionHours !== undefined && summary.RetentionPeriodHours !== want.retentionHours ? [`retention is ${summary.RetentionPeriodHours} hours (config: ${want.retentionHours})`] : []),
  ];
}

const outputsOf = (summary: Summary): Record<string, string> => ({
  arn: summary.StreamARN ?? "",
  mode: modeOf(summary).toLowerCase().replace("_", "-"),
  shards: String(summary.OpenShardCount ?? ""),
  retention_hours: String(summary.RetentionPeriodHours ?? ""),
});

const named = (err: unknown, ...names: string[]): boolean => names.includes((err as { name?: string }).name ?? "");

const refusal = (current: StateEntry): string | undefined =>
  destroyAllowed(current)
    ? undefined
    : `Refusing to delete Kinesis stream "${current.physical_name}": it holds data. Declare it with allowDestroy: true, apply, then remove it.`;

export function kinesisDriver(deps: KinesisDeps): Driver {
  async function describe(name: string): Promise<Summary | undefined> {
    try {
      return (await deps.kinesis.send(new DescribeStreamSummaryCommand({ StreamName: name }))).StreamDescriptionSummary;
    } catch (err) {
      if (named(err, "ResourceNotFoundException")) return undefined;
      throw err;
    }
  }

  // A stream accepts one change at a time; each step waits until it is ACTIVE again.
  async function active(name: string): Promise<Summary> {
    for (let attempt = 0; attempt < ACTIVE_ATTEMPTS; attempt++) {
      const summary = await describe(name);
      if (!summary) throw new Error(`Kinesis stream "${name}" disappeared while waiting for it`);
      if (summary.StreamStatus === "ACTIVE") return summary;
      await deps.sleep(ACTIVE_WAIT_MS);
    }
    throw new Error(`Kinesis stream "${name}" is still not ACTIVE after ${(ACTIVE_ATTEMPTS * ACTIVE_WAIT_MS) / 1000} seconds; run apply again`);
  }

  async function converge(name: string, want: Wanted): Promise<Summary> {
    let summary = await active(name);
    if (want.mode && modeOf(summary) !== want.mode) {
      await deps.kinesis.send(new UpdateStreamModeCommand({ StreamARN: summary.StreamARN, StreamModeDetails: { StreamMode: want.mode } }));
      deps.log(`switching Kinesis stream ${name} to ${want.mode.toLowerCase().replace("_", "-")}`);
      summary = await active(name);
    }
    if (want.shards !== undefined && modeOf(summary) === "PROVISIONED" && summary.OpenShardCount !== want.shards) {
      await deps.kinesis.send(new UpdateShardCountCommand({ StreamName: name, TargetShardCount: want.shards, ScalingType: "UNIFORM_SCALING" }));
      deps.log(`scaling Kinesis stream ${name} to ${want.shards} shards`);
      summary = await active(name);
    }
    if (want.retentionHours !== undefined && summary.RetentionPeriodHours !== want.retentionHours) {
      const current = summary.RetentionPeriodHours ?? DEFAULT_RETENTION_HOURS;
      const command = want.retentionHours > current ? IncreaseStreamRetentionPeriodCommand : DecreaseStreamRetentionPeriodCommand;
      await deps.kinesis.send(new command({ StreamName: name, RetentionPeriodHours: want.retentionHours }));
      summary = await active(name);
    }
    return summary;
  }

  async function ensure(entry: DesiredEntry): Promise<Record<string, string>> {
    const want = wanted(entry.spec);
    const name = entry.physical_name;
    if (await describe(name)) {
      deps.log(`adopted existing Kinesis stream ${name}`);
    } else {
      const mode = want.mode ?? "PROVISIONED";
      try {
        await deps.kinesis.send(
          new CreateStreamCommand({
            StreamName: name,
            StreamModeDetails: { StreamMode: mode },
            ...(mode === "PROVISIONED" ? { ShardCount: want.shards ?? DEFAULT_SHARDS } : {}),
            ...(deps.tags ? { Tags: Object.fromEntries(tagList(deps.tags(entry.name)).map((t) => [t.Key, t.Value])) } : {}),
          }),
        );
        deps.log(`created Kinesis stream ${name}`);
      } catch (err) {
        if (!named(err, "ResourceInUseException")) throw err;
      }
    }
    return outputsOf(await converge(name, want));
  }

  return {
    create: (entry) => ensure(entry),
    update: (entry) => ensure(entry),
    protect: refusal,
    async delete(current) {
      const reason = refusal(current);
      if (reason) throw new Error(reason);
      try {
        await deps.kinesis.send(new DeleteStreamCommand({ StreamName: current.physical_name, EnforceConsumerDeletion: false }));
        deps.log(`deleted Kinesis stream ${current.physical_name}`);
      } catch (err) {
        if (!named(err, "ResourceNotFoundException")) throw err;
      }
    },
    // Read only; a stream that differs is recorded without its spec so the next plan shows the change.
    async adopt(entry): Promise<Adopted | undefined> {
      const summary = await describe(entry.physical_name);
      if (!summary) return undefined;
      const problems = differences(summary, wanted(entry.spec));
      return problems.length
        ? { outputs: outputsOf(summary), spec: { physical_name: entry.physical_name }, notes: [`Kinesis stream "${entry.physical_name}": ${problems.join("; ")}; apply will change it to match the config`] }
        : { outputs: outputsOf(summary), spec: withoutAllowDestroy(entry.spec) };
    },
  };
}
