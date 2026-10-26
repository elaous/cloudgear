import { FunctionRouter } from "@cloudgear/functions";
import { DNS } from "@cloudgear/dns";
import { Cert } from "@cloudgear/cdn";

const dns = new DNS("aws", "example.com");
export const cert = new Cert("aws", dns);

export async function f() {
  return {};
}

new FunctionRouter("aws").url("GET", "/f", f);
