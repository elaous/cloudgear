import { FunctionRouter } from "@cloudgear/functions";

export const f = () => ({});

new FunctionRouter("aws", { ["authenticated"]: "none" }).url("GET", "/f", f);
