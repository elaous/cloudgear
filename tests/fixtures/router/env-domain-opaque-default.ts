import { FunctionRouter } from "@cloudgear/functions";
import { DNS } from "@cloudgear/dns";
import { Cert } from "@cloudgear/cdn";

declare function pick(): string | undefined;
const dns = new DNS("gandi", pick() ?? "fallback.example.com", {});
new Cert("aws", dns);

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
