import { FunctionRouter } from "@cloudgear/functions";
import { Cache } from "@cloudgear/cache";
import { Network } from "@cloudgear/network";

const a = new Cache("aws", "a", { network: new Network("aws", { vpc: "vpc-0abc1234" }) });
const b = new Cache("aws", "b");

export const both = () => ({ a: a.location, b: b.location });
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/c", both);
