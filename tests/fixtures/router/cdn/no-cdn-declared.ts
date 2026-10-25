import { FunctionRouter } from "@cloudgear/functions";
import { DNS } from "@cloudgear/dns";

const dns = new DNS("gandi", "cdn.example.com");
const cdn = { domain: dns.domain };

export async function f() {
  return {};
}

new FunctionRouter("aws", { cdn }).url("GET", "/f", f);
