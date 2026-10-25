import { FunctionRouter } from "@cloudgear/functions";

export const a$b = () => ({});
export const a$$b = () => ({});

new FunctionRouter("aws").add("GET", "/one", a$b).add("GET", "/two", a$$b);
