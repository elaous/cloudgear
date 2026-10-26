import { FunctionRouter, response } from "@cloudgear/functions";

new FunctionRouter("aws").url("GET", "/a", "/api/a-b.ts").url("GET", "/b", "/api/a/b.ts");
