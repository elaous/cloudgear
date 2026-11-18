import { FunctionRouter, jwtAuth } from "@cloudgear/functions";

export const f = () => ({});

new FunctionRouter("aws", { authenticated: "none", authenticate: jwtAuth({ issuer: "https://login.example.com" }) }).url("GET", "/f", f);
