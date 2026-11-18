import { FunctionRouter } from "@cloudgear/functions";
import { Instance } from "@cloudgear/instance";
import { Network } from "@cloudgear/network";

const network = new Network("aws", { vpc: "vpc-0abc1234", subnets: ["subnet-aaaa1111"] });
new Instance("aws", "worker", { network });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
