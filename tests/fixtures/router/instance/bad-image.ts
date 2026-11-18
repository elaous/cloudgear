import { FunctionRouter } from "@cloudgear/functions";
import { Instance } from "@cloudgear/instance";

new Instance("aws", "w", { image: "not-an-ami" });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
