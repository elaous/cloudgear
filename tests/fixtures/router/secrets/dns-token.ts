import { FunctionRouter } from "@cloudgear/functions";
import { DNS } from "@cloudgear/dns";
import { Cert } from "@cloudgear/cdn";
import { SecretStore } from "@cloudgear/secrets";

const store = new SecretStore("aws");
const app = store.path("/cloudgear/myproject");
const dns = new DNS("gandi", "api.example.com", { zone: "example.com", token: app("GANDI_TOKEN") });

export async function items() {
  return {};
}

const cert = new Cert("aws", dns);
new FunctionRouter("aws", { cert }).url("GET", "/items", items);
