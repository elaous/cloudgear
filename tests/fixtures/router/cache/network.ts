import { FunctionRouter } from "@cloudgear/functions";
import { Cache } from "@cloudgear/cache";
import { Network } from "@cloudgear/network";

const network = new Network("aws", { vpc: "vpc-0abc1234", subnets: ["subnet-aaaa1111"], securityGroups: ["sg-0def4001"] });
const cache = new Cache("aws", "sessions", { engine: "memcached", size: "small", network, allowDestroy: true });

export const withCache = () => ({ at: cache.location });
new FunctionRouter("aws", { authenticated: "iam", network }).url("GET", "/c", withCache);
