import { FunctionRouter } from "@cloudgear/functions";

export const ping = () => ({});
new FunctionRouter("aws", { project: "my-proj-123" }).url("GET", "/ping", ping);
