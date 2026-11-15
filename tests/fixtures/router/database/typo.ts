import { FunctionRouter } from "@cloudgear/functions";
import { Database } from "@cloudgear/database";

// @ts-expect-error unknown option
new Database("neon", "db", { regoin: "aws-us-east-1" });

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
