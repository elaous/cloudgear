import { FunctionRouter } from "@cloudgear/functions";
import { Network } from "@cloudgear/network";

// @ts-expect-error unknown option
const network = new Network("aws", { vpcs: "vpc-0abc1234" });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam", network }).url("GET", "/ping", ping);
