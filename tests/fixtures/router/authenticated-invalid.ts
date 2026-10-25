import { FunctionRouter } from "@cloudgear/functions";

export const f = () => ({});

// @ts-expect-error not a valid mode
new FunctionRouter("aws", { authenticated: "aim" }).url("GET", "/f", f);
