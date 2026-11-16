import { FunctionRouter } from "@cloudgear/functions";
import { Cache } from "@cloudgear/cache";
import { Network } from "@cloudgear/network";

const cache = new Cache("aws", "same");
const other = new Cache("aws", "same");

export const ping = () => ({ a: cache.location, b: other.location });
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/c", ping);
