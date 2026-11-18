import { FunctionRouter } from "@cloudgear/functions";
import { Cache } from "@cloudgear/cache";
import { Network } from "@cloudgear/network";

const router = new Network("aws", { vpc: "vpc-0abc1234" });
const cache = new Cache("aws", "sessions");

export const withCache = () => ({ at: cache.location });
new FunctionRouter("aws", { authenticated: "iam", network: router }).url("GET", "/c", withCache);
