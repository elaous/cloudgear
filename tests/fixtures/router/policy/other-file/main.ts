import { FunctionRouter } from "@cloudgear/functions";
import { Api } from "./api";

export const api = new Api();

new FunctionRouter("aws").url("GET", "/read", api.read);
