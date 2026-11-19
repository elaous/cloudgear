import { FunctionRouter } from "@cloudgear/functions";

export const ping = () => ({});
new FunctionRouter("gcp", { region: "us-east-1" }).url("GET", "/ping", ping);
