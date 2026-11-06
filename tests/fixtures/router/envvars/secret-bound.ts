import { FunctionRouter } from "@cloudgear/functions";
import { SecretStore } from "@cloudgear/secrets";

const store = new SecretStore("aws");
const app = store.path("/app");

export async function api() {
  return { key: process.env.STRIPE_KEY };
}

new FunctionRouter("aws").url("GET", "/api", api, { env: app(["STRIPE_KEY"]) });
