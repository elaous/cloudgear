import { FunctionRouter } from "@cloudgear/functions";
import { Cache } from "@cloudgear/cache";
import { Network } from "@cloudgear/network";

new Cache("aws", "sessions");

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/c", ping);
