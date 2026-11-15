import { FunctionRouter } from "@cloudgear/functions";
import { Registry } from "@cloudgear/registry";

// @ts-expect-error unknown option
new Registry("aws", "app", { scanOnpush: true });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
