import { FunctionRouter } from "@cloudgear/functions";

new FunctionRouter("aws").add("GET", "/inline", () => ({}));
