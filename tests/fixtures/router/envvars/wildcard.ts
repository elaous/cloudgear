import { FunctionRouter } from "@cloudgear/functions";
import { SecretStore } from "@cloudgear/secrets";

const store = new SecretStore("aws");
const everything = store.path("/app/*");

export async function api() {
  return { a: process.env.ANYTHING };
}

new FunctionRouter("aws").url("GET", "/api", api, { env: everything });
