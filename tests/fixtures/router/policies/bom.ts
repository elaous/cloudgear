import { FunctionRouter } from "@cloudgear/functions";
import { Policy } from "@cloudgear/iam";
import withBom from "./bom.json";

export async function a() {
  return {};
}

const p = new Policy("aws", { name: "bom", document: withBom });
new FunctionRouter("aws").url("GET", "/a", a, { policies: p });
