import { FunctionRouter } from "@cloudgear/functions";
import { Cache } from "@cloudgear/cache";

const cache = new Cache("aws", "sessions");
const endpoint = () => cache.location;

export const viaHelper = () => ({ at: endpoint() });
export const plain = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/c", viaHelper).url("GET", "/p", plain);
