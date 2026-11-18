import { FunctionRouter } from "@cloudgear/functions";
import { Cache } from "@cloudgear/cache";
import { Network } from "@cloudgear/network";

const cache = new Cache("aws", "sessions", { engine: "dynamo" as "valkey" });

export const ping = () => ({ at: cache.location });
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/c", ping);
