import { FunctionRouter } from "@cloudgear/functions";
import { Stream } from "@cloudgear/stream";

new Stream("aws", "tranquilo-events", { mode: "provisioned", shards: 2, retentionHours: 48, allowDestroy: true });
new Stream("aws", "bursty", { mode: "on-demand" });
new Stream("aws", "plain");

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
