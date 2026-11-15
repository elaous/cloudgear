import { FunctionRouter } from "@cloudgear/functions";
import { Registry } from "@cloudgear/registry";

new Registry("aws", "Bad Name");

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
