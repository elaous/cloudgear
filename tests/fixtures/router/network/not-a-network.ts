import { FunctionRouter } from "@cloudgear/functions";

export const ping = () => ({});
const network = { provider: "aws" };
new FunctionRouter("aws", { authenticated: "iam", network }).url("GET", "/ping", ping);
