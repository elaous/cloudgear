import { FunctionRouter } from "@cloudgear/functions";

export const h = () => ({});

export default new FunctionRouter("aws").add("GET", "/h", h);
