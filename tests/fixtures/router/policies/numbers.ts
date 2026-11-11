import { FunctionRouter } from "@cloudgear/functions";
import { Policy } from "@cloudgear/iam";

export async function a() {
  return {};
}

const p = new Policy("aws", {
  name: "numbers",
  document: {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*", Condition: { NumericGreaterThan: { "s3:max-keys": -1 }, NumericLessThan: { "s3:max-keys": 1_000 } } }],
  },
});
new FunctionRouter("aws").url("GET", "/a", a, { policies: p });
