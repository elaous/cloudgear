import { FunctionRouter } from "@cloudgear/functions";
import { Network } from "@cloudgear/network";

const network = new Network("aws");

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam", network }).url("GET", "/ping", ping, { options: { vpc: "vpc-0abc9999" } });
