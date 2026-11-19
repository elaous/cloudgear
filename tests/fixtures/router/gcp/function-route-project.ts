import { FunctionRouter } from "@cloudgear/functions";

export const ping = () => ({});
new FunctionRouter("gcp", { project: "my-proj-123", region: "us-central1" }).url("GET", "/ping", ping, { options: { project: "other-proj-456" } });
