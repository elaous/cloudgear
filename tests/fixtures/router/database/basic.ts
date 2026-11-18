import { FunctionRouter } from "@cloudgear/functions";
import { Database } from "@cloudgear/database";

new Database("neon", "tranquilo-app", { region: "aws-us-east-1", postgres: 17, allowDestroy: true });
new Database("neon", "analytics");

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
