import { FunctionRouter } from "@cloudgear/functions";
import { Stream } from "@cloudgear/stream";

new Stream("aws", "s", { mode: "on-demand", shards: 2 });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
