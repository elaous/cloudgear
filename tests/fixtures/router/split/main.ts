import { router } from "./router";

export const hello = () => ({ hello: true });

router.url("GET", "/hello", hello);
router.listen();
