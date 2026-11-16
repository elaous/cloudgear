import { FunctionRouter } from "@cloudgear/functions";
import { Cache } from "@cloudgear/cache";

const cache = new Cache("aws", "sessions");
const alias = cache;

export const viaAlias = () => ({ at: alias.location });
export const plain = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/c", viaAlias).url("GET", "/p", plain);
