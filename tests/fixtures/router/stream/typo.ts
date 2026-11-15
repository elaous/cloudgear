import { FunctionRouter } from "@cloudgear/functions";
import { Stream } from "@cloudgear/stream";

// @ts-expect-error unknown option
new Stream("aws", "s", { shard: 2 });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
