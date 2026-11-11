import { FunctionRouter } from "@cloudgear/functions";
import { Policy } from "@cloudgear/iam";
import readBucket from "./read-bucket.json";

export async function a() {
  return {};
}

const p = new Policy("aws", { name: "everything", document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] } });
new FunctionRouter("aws").url("GET", "/a", a, { policies: p });
