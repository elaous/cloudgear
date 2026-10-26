import { FunctionRouter } from "@cloudgear/functions";

new FunctionRouter("aws").url("GET", "/items/{other}", "./handlers/save.ts");
