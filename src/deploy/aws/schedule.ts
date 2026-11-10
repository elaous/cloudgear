import { DeleteRuleCommand, DescribeRuleCommand, PutRuleCommand, PutTargetsCommand, RemoveTargetsCommand } from "@aws-sdk/client-eventbridge";
import { AddPermissionCommand, RemovePermissionCommand } from "@aws-sdk/client-lambda";
import { createHash } from "node:crypto";
import { PartialApplyError, type Driver } from "../apply";
import type { ScheduleComparable } from "../plan";
import type { SendClient } from "./index";
import { tagList, type Tagger } from "./tags";

export interface ScheduleDeps {
  tags?: Tagger;
  events: SendClient;
  lambda: SendClient;
  log: (message: string) => void;
}

const TARGET_ID = "cloudgear";

// Keeps the scheduled event and adds the query the run carries: the adapter reads it from `cloudgear.query`.
export function queryTransformer(query: Record<string, string>) {
  for (const [name, value] of Object.entries(query)) {
    if (!/^[A-Za-z0-9_.:/-]+$/.test(name) || !/^[A-Za-z0-9_.:/-]*$/.test(value)) throw new Error(`Invalid schedule query ${name}=${value}: use letters, digits and _ . : / -`);
  }
  const template = `{"source":"aws.events","detail-type":"Scheduled Event","time":"<time>","resources":["<rule>"],"cloudgear":{"query":${JSON.stringify(query)}}}`;
  if (template.length > 8192) throw new Error("The schedule's query is too long for an EventBridge input template (8192 characters)");
  return {
    InputPathsMap: { time: "$.time", rule: "$.resources[0]" },
    InputTemplate: template,
  };
}

const statementId = (rule: string) => `cloudgear-schedule-${createHash("sha256").update(rule).digest("hex").slice(0, 12)}`;

export function scheduleDriver(deps: ScheduleDeps): Driver {
  async function converge(
    ruleName: string,
    spec: ScheduleComparable,
    functionArn: string | undefined,
    outputs: Record<string, string>,
  ): Promise<Record<string, string>> {
    if (!functionArn) throw new Error(`Function ${spec.function} has no ARN yet; apply it first`);
    try {
      const rule = await deps.events.send(
        new PutRuleCommand({ Name: ruleName, ScheduleExpression: spec.expression, State: "ENABLED", Description: `cloudgear: ${spec.cron} UTC`, ...(deps.tags ? { Tags: tagList(deps.tags(spec.function)) } : {}) }),
      );
      outputs.rule_name = ruleName;
      outputs.rule_arn = rule.RuleArn;
      try {
        await deps.lambda.send(
          new AddPermissionCommand({
            FunctionName: spec.function,
            StatementId: statementId(ruleName),
            Action: "lambda:InvokeFunction",
            Principal: "events.amazonaws.com",
            SourceArn: rule.RuleArn,
          }),
        );
      } catch (err) {
        const e = err as { name?: string; message?: string };
        if (!(e.name === "ResourceConflictException" && /statement id.*already exists/i.test(e.message ?? ""))) throw err;
      }
      const put = await deps.events.send(new PutTargetsCommand({ Rule: ruleName, Targets: [{ Id: TARGET_ID, Arn: functionArn, ...(spec.query ? { InputTransformer: queryTransformer(spec.query) } : {}) }] }));
      if (put.FailedEntryCount) throw new Error(`EventBridge rejected the target of ${ruleName}: ${put.FailedEntries?.[0]?.ErrorMessage}`);
      deps.log(`${spec.function} runs on ${spec.cron} (UTC)`);
      return outputs;
    } catch (err) {
      throw outputs.rule_arn ? new PartialApplyError(err, outputs) : err;
    }
  }

  const functionArn = (spec: ScheduleComparable, context: Parameters<Driver["create"]>[1]) => context.entry(spec.function_key)?.outputs.arn;

  return {
    async adopt(entry, _context, hint) {
      if (hint?.arn) {
        const named = /^arn:aws:events:[a-z0-9-]+:\d+:rule\/(?:[^/]+\/)?(.+)$/.exec(hint.arn)?.[1];
        if (!named) throw new Error(`"${hint.arn}" is not an EventBridge rule ARN`);
        if (named !== entry.physical_name) throw new Error(`${hint.arn} is the rule "${named}", but the config deploys "${entry.physical_name}"`);
      }
      try {
        const rule = await deps.events.send(new DescribeRuleCommand({ Name: entry.physical_name }));
        return rule.Arn ? { outputs: { rule_name: entry.physical_name, rule_arn: rule.Arn } } : undefined;
      } catch (err) {
        if ((err as { name?: string }).name === "ResourceNotFoundException") return undefined;
        throw err;
      }
    },
    create: (entry, context) => {
      const spec = entry.spec as unknown as ScheduleComparable;
      return converge(entry.physical_name, spec, functionArn(spec, context), {});
    },
    update: (entry, current, _changes, context) => {
      const spec = entry.spec as unknown as ScheduleComparable;
      return converge(entry.physical_name, spec, functionArn(spec, context), { ...current.outputs });
    },
    async delete(current) {
      const spec = current.spec as unknown as ScheduleComparable;
      const name = current.physical_name;
      await ignoreMissing(deps.events.send(new RemoveTargetsCommand({ Rule: name, Ids: [TARGET_ID] })));
      await ignoreMissing(deps.events.send(new DeleteRuleCommand({ Name: name })));
      await ignoreMissing(deps.lambda.send(new RemovePermissionCommand({ FunctionName: spec.function, StatementId: statementId(name) })));
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
