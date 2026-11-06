import { CreateEventBusCommand, DeleteEventBusCommand, DeleteRuleCommand, PutRuleCommand, PutTargetsCommand, RemoveTargetsCommand } from "@aws-sdk/client-eventbridge";
import { AddPermissionCommand, RemovePermissionCommand } from "@aws-sdk/client-lambda";
import { createHash } from "node:crypto";
import { PartialApplyError, type Driver } from "../apply";
import type { EventRuleComparable } from "../plan";
import type { SendClient } from "./index";
import { tagList, type Tagger } from "./tags";

export interface EventBusDeps {
  tags?: Tagger;
  events: SendClient;
  lambda: SendClient;
  log: (message: string) => void;
}

const TARGET_ID = "cloudgear";

const statementId = (rule: string, bus: string) => `cloudgear-event-${createHash("sha256").update(`${bus}\0${rule}`).digest("hex").slice(0, 12)}`;

// The pattern a rule matches: the event type, and the source when one is given.
export function eventPattern(spec: Pick<EventRuleComparable, "event_type" | "source">): string {
  return JSON.stringify({ "detail-type": [spec.event_type], ...(spec.source ? { source: [spec.source] } : {}) });
}

// Custom buses cloudgear creates; the account's default bus is dry and never reaches this driver.
export function eventBusDriver(deps: EventBusDeps): Driver {
  return {
    async create(entry) {
      const created = await deps.events.send(new CreateEventBusCommand({ Name: entry.physical_name, ...(deps.tags ? { Tags: tagList(deps.tags(entry.name)) } : {}) }));
      deps.log(`created event bus ${entry.physical_name}`);
      return { arn: created.EventBusArn };
    },
    async update() {
      return {};
    },
    async delete(current) {
      await ignoreMissing(deps.events.send(new DeleteEventBusCommand({ Name: current.physical_name })));
    },
  };
}

export function eventRuleDriver(deps: EventBusDeps): Driver {
  async function converge(ruleName: string, spec: EventRuleComparable, functionArn: string | undefined, outputs: Record<string, string>): Promise<Record<string, string>> {
    if (!functionArn) throw new Error(`Function ${spec.function} has no ARN yet; apply it first`);
    const bus = spec.bus === "default" ? {} : { EventBusName: spec.bus };
    try {
      const rule = await deps.events.send(
        new PutRuleCommand({
          Name: ruleName,
          ...bus,
          EventPattern: eventPattern(spec),
          State: "ENABLED",
          Description: `cloudgear: ${spec.event_type}${spec.source ? ` from ${spec.source}` : ""}`,
          ...(deps.tags ? { Tags: tagList(deps.tags(spec.function)) } : {}),
        }),
      );
      outputs.rule_name = ruleName;
      outputs.rule_arn = rule.RuleArn;
      try {
        await deps.lambda.send(
          new AddPermissionCommand({
            FunctionName: spec.function,
            StatementId: statementId(ruleName, spec.bus),
            Action: "lambda:InvokeFunction",
            Principal: "events.amazonaws.com",
            SourceArn: rule.RuleArn,
          }),
        );
      } catch (err) {
        const e = err as { name?: string; message?: string };
        if (!(e.name === "ResourceConflictException" && /statement id.*already exists/i.test(e.message ?? ""))) throw err;
      }
      const put = await deps.events.send(new PutTargetsCommand({ Rule: ruleName, ...bus, Targets: [{ Id: TARGET_ID, Arn: functionArn }] }));
      if (put.FailedEntryCount) throw new Error(`EventBridge rejected the target of ${ruleName}: ${put.FailedEntries?.[0]?.ErrorMessage}`);
      deps.log(`${spec.function} runs on ${spec.event_type} events${spec.bus === "default" ? "" : ` of ${spec.bus}`}`);
      return outputs;
    } catch (err) {
      throw outputs.rule_arn ? new PartialApplyError(err, outputs) : err;
    }
  }

  const functionArn = (spec: EventRuleComparable, context: Parameters<Driver["create"]>[1]) => context.entry(spec.function_key)?.outputs.arn;

  return {
    create: (entry, context) => {
      const spec = entry.spec as unknown as EventRuleComparable;
      return converge(entry.physical_name, spec, functionArn(spec, context), {});
    },
    update: (entry, current, _changes, context) => {
      const spec = entry.spec as unknown as EventRuleComparable;
      return converge(entry.physical_name, spec, functionArn(spec, context), { ...current.outputs });
    },
    async delete(current) {
      const spec = current.spec as unknown as EventRuleComparable;
      const name = current.physical_name;
      const bus = spec.bus === "default" ? {} : { EventBusName: spec.bus };
      await ignoreMissing(deps.events.send(new RemoveTargetsCommand({ Rule: name, ...bus, Ids: [TARGET_ID] })));
      await ignoreMissing(deps.events.send(new DeleteRuleCommand({ Name: name, ...bus })));
      await ignoreMissing(deps.lambda.send(new RemovePermissionCommand({ FunctionName: spec.function, StatementId: statementId(name, spec.bus) })));
    },
  };
}

async function ignoreMissing(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if ((err as { name?: string }).name !== "ResourceNotFoundException") throw err;
  }
}
