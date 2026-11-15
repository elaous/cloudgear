import { FunctionRouter } from "@cloudgear/functions";
import { Database } from "@cloudgear/database";

const allow = Math.random() > 1;
new Database("neon", "db", { allowDestroy: allow });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
