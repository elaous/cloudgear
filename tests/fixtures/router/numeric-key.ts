import { FunctionRouter } from "@cloudgear/functions";

export const f = () => ({});

// @ts-expect-error numeric keys are not router options
new FunctionRouter("aws", { 0: "x", authenticated: "iam" }).url("GET", "/f", f);
