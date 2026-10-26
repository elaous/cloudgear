import { FunctionRouter } from "@cloudgear/functions";

new FunctionRouter("aws").url("GET", "/x", "./handlers/named.ts");
