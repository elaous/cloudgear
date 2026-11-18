import { FunctionRouter } from "@cloudgear/functions";
import { Cache } from "@cloudgear/cache";
import { Network } from "@cloudgear/network";

const cache = new Cache("aws", "sessions");

export const withCache = () => ({ at: cache.location });
export const plain = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/c", withCache).url("GET", "/p", plain);
