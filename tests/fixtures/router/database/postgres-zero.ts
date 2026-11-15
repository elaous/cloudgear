import { FunctionRouter } from "@cloudgear/functions";
import { Database } from "@cloudgear/database";

new Database("neon", "db", { postgres: 0 as 17 });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
