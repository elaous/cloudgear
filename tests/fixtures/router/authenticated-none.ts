import { FunctionRouter } from "@cloudgear/functions";

export const open = () => ({});

new FunctionRouter("aws", { authenticated: "none", rateLimit: { limit: 5, windowMs: 1000 } }).add("GET", "/open", open);
