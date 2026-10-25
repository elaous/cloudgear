import { FunctionRouter } from "@cloudgear/functions";

const options = { authenticated: "iam" } as const;

export const f = () => ({});

new FunctionRouter("aws", options).add("GET", "/f", f);
