import { FunctionRouter } from "@cloudgear/functions";

export const h = () => ({});

function register(target: FunctionRouter) {
  target.add("GET", "/z", h);
}

const router = new FunctionRouter("aws");
register(router);
