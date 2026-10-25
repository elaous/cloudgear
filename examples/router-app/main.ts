import { FunctionRouter } from "@cloudgear/functions";
import * as functions from "server/api";

function main() {
  const router = new FunctionRouter("aws")
    .add("POST", "/foo/{param}", functions.foo)
    .add("GET", "/foo/{param}", functions.getFoo)
    .add("GET", "/health", functions.health);
  router.listen();
}

main();
