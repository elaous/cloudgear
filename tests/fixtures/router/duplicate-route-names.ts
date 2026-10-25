import { FunctionRouter } from "@cloudgear/functions";

export const first = () => ({});
export const second = () => ({});

new FunctionRouter("aws").add("GET", "/a", first, { name: "same" }).add("GET", "/b", second, { name: "same" });
