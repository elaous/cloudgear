import { router } from "./router";

export const hello = () => ({ hello: true });

router.add("GET", "/hello", hello);
router.listen();
