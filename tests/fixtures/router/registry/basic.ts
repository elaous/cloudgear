import { FunctionRouter } from "@cloudgear/functions";
import { Registry } from "@cloudgear/registry";

new Registry("aws", "tranquilo/web", { scanOnPush: false, immutableTags: true, keepUntaggedDays: 30, allowDestroy: true });
new Registry("aws", "tranquilo/api", { keepUntaggedDays: false });
new Registry("aws", "tranquilo/worker");

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
