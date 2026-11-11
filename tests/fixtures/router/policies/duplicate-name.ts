import { FunctionRouter } from "@cloudgear/functions";
import { Policy } from "@cloudgear/iam";
import readBucket from "./read-bucket.json";

export async function a() {
  return {};
}

const one = new Policy("aws", { name: "same", document: readBucket });
const two = new Policy("aws", { name: "same", document: readBucket });
new FunctionRouter("aws").url("GET", "/a", a, { policies: [one, two] });
