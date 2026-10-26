import { FunctionRouter } from "@cloudgear/functions";
import { DNS } from "@cloudgear/dns";
import { Cert } from "@cloudgear/cdn";

const dns = new DNS("gandi", "api.example.com");
const cert = new Cert("aws", dns);

export async function f() {
  return {};
}

new FunctionRouter("gcp", { cert }).url("GET", "/f", f);
