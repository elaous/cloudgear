import { FunctionRouter } from "@cloudgear/functions";
import { Network } from "@cloudgear/network";

const vpc = new Network("aws");

export const ping = () => ({});
export const pong = () => ({});
new FunctionRouter("aws", { authenticated: "iam", network: vpc }).url("GET", "/ping", ping).url("GET", "/pong", pong);
