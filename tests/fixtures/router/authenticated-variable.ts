import { FunctionRouter } from "@cloudgear/functions";

const mode = "iam";

export const f = () => ({});

new FunctionRouter("aws", { authenticated: mode }).add("GET", "/f", f);
