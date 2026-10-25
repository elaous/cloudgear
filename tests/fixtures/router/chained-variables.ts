import { FunctionRouter } from "@cloudgear/functions";

export const a = () => ({});
export const b = () => ({});
export const c = () => ({});

const router = new FunctionRouter("aws");
const second = router.add("GET", "/a", a);
const third = second.add("GET", "/b", b);
third.add("GET", "/c", c).listen();
