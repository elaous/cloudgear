import { FunctionRouter } from "@cloudgear/functions";

export const ping = () => ({});
new FunctionRouter("gcp", { authenticated: "none", region: "us-central1", project: "my-proj-123" }).url("GET", "/ping", ping);
