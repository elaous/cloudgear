import { FunctionRouter } from "@cloudgear/functions";
import { Database } from "@cloudgear/database";

new Database("neon", "db", { region: "" });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
