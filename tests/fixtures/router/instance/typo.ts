import { FunctionRouter } from "@cloudgear/functions";
import { Instance } from "@cloudgear/instance";

// @ts-expect-error unknown option
new Instance("aws", "w", { sizee: "small" });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
