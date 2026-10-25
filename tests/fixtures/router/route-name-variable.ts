import { FunctionRouter } from "@cloudgear/functions";

const label = "x";

export const f = () => ({});

new FunctionRouter("aws").url("GET", "/f", f, { name: label });
