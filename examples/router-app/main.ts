import { FunctionRouter } from "@cloudgear/functions";
import * as functions from "server/api";

function main() {
  const router = new FunctionRouter("aws", { authenticated: "iam" })
    .add("POST", "/foo/{param}", functions.foo, { name: "createFoo" })
    .add("GET", "/foo/{param}", functions.getFoo)
    .add("GET", "/health", functions.health);
  const urls = router.listen();
  console.log(urls);
}

main();
