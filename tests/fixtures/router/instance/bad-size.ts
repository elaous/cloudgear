import { FunctionRouter } from "@cloudgear/functions";
import { Instance } from "@cloudgear/instance";

new Instance("aws", "w", { size: "huge" as "small" });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
