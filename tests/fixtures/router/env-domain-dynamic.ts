import { FunctionRouter } from "@cloudgear/functions";
import { DNS } from "@cloudgear/dns";
import { Cert } from "@cloudgear/cdn";

const pick = () => "x.example.com";
const dns = new DNS("gandi", pick(), {});
new Cert("aws", dns);

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
