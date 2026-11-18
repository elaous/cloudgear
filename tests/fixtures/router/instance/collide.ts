import { FunctionRouter } from "@cloudgear/functions";
import { Instance } from "@cloudgear/instance";

new Instance("aws", "a b");
new Instance("aws", "a.b");

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
