import { FunctionRouter } from "@cloudgear/functions";

const label = "x";

export const f = () => ({});

new FunctionRouter("aws").add("GET", "/f", f, { name: label });
