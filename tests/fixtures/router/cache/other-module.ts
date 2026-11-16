import { FunctionRouter } from "@cloudgear/functions";
import { cache } from "./shared-cache";

export const viaImport = () => ({ at: cache.location });
export const plain = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/c", viaImport).url("GET", "/p", plain);
