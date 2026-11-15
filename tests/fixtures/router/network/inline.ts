import { FunctionRouter } from "@cloudgear/functions";
import { Network } from "@cloudgear/network";

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam", network: new Network("aws", { vpc: "vpc-0abc1234" }) }).url("GET", "/ping", ping);
