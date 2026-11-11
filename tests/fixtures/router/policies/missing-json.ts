import { FunctionRouter } from "@cloudgear/functions";
import { Policy } from "@cloudgear/iam";
import readBucket from "./read-bucket.json";

export async function a() {
  return {};
}

import missing from "./nope.json";
const p = new Policy("aws", { name: "missing", document: missing });
new FunctionRouter("aws").url("GET", "/a", a, { policies: p });
