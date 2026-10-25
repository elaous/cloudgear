import { FunctionRouter } from "@cloudgear/functions";

const base = { authenticated: "iam" } as const;

export const f = () => ({});

new FunctionRouter("aws", { ...base }).url("GET", "/f", f);
