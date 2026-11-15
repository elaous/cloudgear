import { FunctionRouter } from "@cloudgear/functions";
import { Network } from "@cloudgear/network";

const network = new Network("aws", { vpc: "vpc-0abc1234", subnets: ["subnet-aaaa1111", "subnet-bbbb2222"], securityGroups: ["sg-0def4001"] });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam", network }).url("GET", "/ping", ping);
