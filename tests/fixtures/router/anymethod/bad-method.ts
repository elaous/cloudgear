import { FunctionRouter } from "@cloudgear/functions";

new FunctionRouter("aws").url("FOO", "/", "./api/item.ts");
