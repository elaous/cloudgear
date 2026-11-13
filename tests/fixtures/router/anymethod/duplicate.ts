import { FunctionRouter } from "@cloudgear/functions";

new FunctionRouter("aws").url("*", "/x", "./api/item.ts", { name: "a" }).url("*", "/x", "./api/item.ts", { name: "b" });
