import { FunctionRouter } from "@cloudgear/functions";

export const h = () => ({});

export default new FunctionRouter("aws").url("GET", "/h", h);
