import { FunctionRouter } from "@cloudgear/functions";

export const f = () => ({});

new FunctionRouter("aws", { authenticated: "none", authenticate: () => null }).url("GET", "/f", f);
