import { FunctionRouter } from "@cloudgear/functions";
import { Instance } from "@cloudgear/instance";

new Instance("aws", "worker", { size: "small", image: "ami-0abc1234", diskGb: 20, keyName: "ops", profile: "worker-profile", userData: "#!/bin/sh\necho hi\n", allowDestroy: true });
new Instance("aws", "plain");

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
