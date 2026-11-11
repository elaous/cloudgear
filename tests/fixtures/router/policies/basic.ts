import { FunctionRouter } from "@cloudgear/functions";
import { Policy } from "@cloudgear/iam";
import readBucket from "./read-bucket.json";

const reader = new Policy("aws", { name: "read-bucket", document: readBucket });
const queue = new Policy("aws", {
  name: "send-queue",
  document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: "arn:aws:sqs:us-east-1:111122223333:jobs" }] },
});
const shared = new Policy("aws", {
  name: "shared-audit",
  document: { Version: "2012-10-17", Statement: { Effect: "Allow", Action: ["logs:PutLogEvents"], Resource: "arn:aws:logs:*:*:*" } },
});

export async function a() {
  return {};
}

export async function b() {
  return {};
}

new FunctionRouter("aws", { policies: shared })
  .url("GET", "/a", a, { policies: [reader, queue] })
  .url("GET", "/b", b, { policies: reader });
