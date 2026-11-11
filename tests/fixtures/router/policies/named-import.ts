import { FunctionRouter } from "@cloudgear/functions";
import { Policy } from "@cloudgear/iam";
import { Statement } from "./read-bucket.json";

export async function a() {
  return {};
}

const p = new Policy("aws", { name: "named", document: { Version: "2012-10-17", Statement } });
new FunctionRouter("aws").url("GET", "/a", a, { policies: p });
