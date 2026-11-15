import { FunctionRouter } from "@cloudgear/functions";

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
