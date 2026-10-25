import { FunctionRouter } from "@cloudgear/functions";

export const first = () => ({});
export const second = () => ({});

new FunctionRouter("aws").url("GET", "/a", first, { name: "same" }).url("GET", "/b", second, { name: "same" });
