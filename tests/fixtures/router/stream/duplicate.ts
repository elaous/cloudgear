import { FunctionRouter } from "@cloudgear/functions";
import { Stream } from "@cloudgear/stream";

new Stream("aws", "same");
new Stream("aws", "same");

export const ping = () => ({});
new FunctionRouter("aws", { authenticated: "iam" }).url("GET", "/ping", ping);
