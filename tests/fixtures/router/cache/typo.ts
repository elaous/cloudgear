import { FunctionRouter } from "@cloudgear/functions";
import { Cache } from "@cloudgear/cache";
import { Network } from "@cloudgear/network";

// @ts-expect-error unknown option
const cache = new Cache("aws", "sessions", { enginee: "valkey" });

export const ping = () => ({ at: cache.location });
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/c", ping);
