import { FunctionRouter } from "@cloudgear/functions";
import * as functions from "server/api";

function main() {
  const router = new FunctionRouter("aws", { authenticated: "iam" })
    .url("POST", "/foo/{param}", functions.foo, { name: "createFoo" })
    .url("GET", "/foo/{param}", functions.getFoo)
    .url("GET", "/health", functions.health);
  const urls = router.listen();
  console.log(urls);
}

main();
