import { FunctionRouter } from "@cloudgear/functions";
import { DNS } from "@cloudgear/dns";
import { BlobStore } from "@cloudgear/blob";
import { Cert } from "@cloudgear/cdn";

const held = process.env.D5;
const chained = process.env.D6!;
const alias = chained;
const zone = process.env.D7!;

const dns0 = new DNS("gandi", `a.${process.env.D1}`, {});
new Cert("aws", dns0);
const dns1 = new DNS("gandi", Bun.env.D2!, {});
new Cert("aws", dns1);
const dns2 = new DNS("gandi", import.meta.env.D3!, {});
new Cert("aws", dns2);
const dns3 = new DNS("gandi", (process.env.D4 as string) || "d4.example.com", {});
new Cert("aws", dns3);
const dns4 = new DNS("gandi", held ?? "d5.example.com", {});
new Cert("aws", dns4);
const dns5 = new DNS("gandi", alias, {});
new Cert("aws", dns5);
const dns6 = new DNS("gandi", "" || "d8.example.com", {});
new Cert("aws", dns6);
const dns7 = new DNS("gandi", "d9." + process.env.D9, {});
new Cert("aws", dns7);
const dnsZone = new DNS("gandi", "api.zone.example.com", { zone });
new Cert("aws", dnsZone);
const store = new BlobStore("aws", "s3://bucket-" + process.env.BUCKET!, { path: `/${process.env.PREFIX}` });
store.get;

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam", region: process.env.REGION ?? "us-east-1" }).url("GET", "/ping", ping);
