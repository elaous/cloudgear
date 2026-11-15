import { FunctionRouter } from "@cloudgear/functions";
import { Network } from "@cloudgear/network";

const network = new Network("aws", { vpc: process.env.VPC_ID! });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam", network }).url("GET", "/ping", ping);
