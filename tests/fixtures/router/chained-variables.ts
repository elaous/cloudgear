import { FunctionRouter } from "@cloudgear/functions";

export const a = () => ({});
export const b = () => ({});
export const c = () => ({});

const router = new FunctionRouter("aws");
const second = router.url("GET", "/a", a);
const third = second.url("GET", "/b", b);
third.url("GET", "/c", c).listen();
