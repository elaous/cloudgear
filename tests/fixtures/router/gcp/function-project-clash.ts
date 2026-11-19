import { FunctionRouter } from "@cloudgear/functions";

export const ping = () => ({});
new FunctionRouter("gcp", { project: "my-proj-123", functionOptions: { project: "other-proj-456" } }).url("GET", "/ping", ping);
