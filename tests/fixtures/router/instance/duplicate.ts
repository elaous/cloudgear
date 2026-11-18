import { FunctionRouter } from "@cloudgear/functions";
import { Instance } from "@cloudgear/instance";

new Instance("aws", "same");
new Instance("aws", "same");

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
