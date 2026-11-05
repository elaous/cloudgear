import { FunctionRouter } from "@cloudgear/functions";
import { SecretStore } from "@cloudgear/secrets";

const store = new SecretStore("aws");
const everything = store.path("/cloudgear/myproject/*");

export async function charge() {
  return {};
}

new FunctionRouter("aws").url("POST", "/charge", charge, { env: everything });
