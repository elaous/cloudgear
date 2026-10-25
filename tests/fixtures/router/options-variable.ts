import { FunctionRouter } from "@cloudgear/functions";

const options = { authenticated: "iam" } as const;

export const f = () => ({});

new FunctionRouter("aws", options).url("GET", "/f", f);
