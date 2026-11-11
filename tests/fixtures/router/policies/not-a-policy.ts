import { FunctionRouter } from "@cloudgear/functions";
import { Policy } from "@cloudgear/iam";
import readBucket from "./read-bucket.json";

export async function a() {
  return {};
}

new FunctionRouter("aws").url("GET", "/a", a, { policies: readBucket as never });
