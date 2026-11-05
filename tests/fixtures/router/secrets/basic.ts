import { FunctionRouter } from "@cloudgear/functions";
import { SecretStore } from "@cloudgear/secrets";

const ss = new SecretStore("aws");
const app = ss.path("/cloudgear/myproject");

export async function charge() {
  return {};
}

new FunctionRouter("aws").url("POST", "/charge", charge, { env: app(["STRIPE_KEY", "DB_URL"]) });
