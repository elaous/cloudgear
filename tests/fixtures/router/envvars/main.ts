import { FunctionRouter } from "@cloudgear/functions";
import { SecretStore } from "@cloudgear/secrets";
import { check, dbUrl, region } from "./lib";

const store = new SecretStore("aws");
const app = store.path("/app");

export async function api() {
  const { MODE, RETRIES = "3" } = process.env;
  return { dbUrl, region: region(), check: check(), key: process.env.STRIPE_KEY, token: Bun.env.API_TOKEN!, mode: MODE, retries: RETRIES, aws: process.env.AWS_REGION, tz: process.env.TZ, lit: process.env.LITERAL };
}

export async function worker() {
  return { quiet: process.env.WORKER_ONLY };
}

new FunctionRouter("aws", { functionOptions: { "env.LITERAL": "x" } })
  .url("GET", "/api", api, { env: app(["STRIPE_KEY"]) })
  .url("GET", "/worker", worker);
