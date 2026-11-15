import { FunctionRouter } from "@cloudgear/functions";
import { Network } from "@cloudgear/network";

const network = new Network("aws");

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam", network, functionOptions: { vpc: "vpc-0abc1234" } }).url("GET", "/ping", ping);
