import { FunctionRouter } from "@cloudgear/functions";
import { SecretStore } from "@cloudgear/secrets";

const store = new SecretStore("aws");
const app = store.path("/cloudgear/myproject");
const name = process.env.WHICH ?? "X";

export async function charge() {
  return {};
}

new FunctionRouter("aws").url("POST", "/charge", charge, { env: app([name]) });
