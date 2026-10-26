import { FunctionRouter } from "@cloudgear/functions";

new FunctionRouter("aws").url("GET", "/hello", "./handlers/nope.ts");
