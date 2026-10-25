import { FunctionRouter } from "@cloudgear/functions";

export const a$b = () => ({});
export const a$$b = () => ({});

new FunctionRouter("aws").url("GET", "/one", a$b).url("GET", "/two", a$$b);
