import { FunctionRouter } from "@cloudgear/functions";
import { DNS } from "@cloudgear/dns";
import { Cert } from "@cloudgear/cdn";

const dns = new DNS("gandi", "api.example.com");
const cert = new Cert("aws", dns);
const options = { cert };

export async function f() {
  return {};
}

new FunctionRouter("aws", { ...options }).url("GET", "/f", f);
