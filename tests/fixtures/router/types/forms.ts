import { FunctionRouter } from "@cloudgear/functions";
import { EventBus } from "@cloudgear/events";
import { SecretStore } from "@cloudgear/secrets";

const store = new SecretStore("aws");
const app = store.path("/app");
const everything = store.path("/app/*");
const bus = new EventBus("aws", { name: "orders" });

export async function a() {
  return {};
}

export async function b() {
  return {};
}

const env = app(["A"]);
const on = bus.event("x");

new FunctionRouter("aws", { env: [app(["A"]), app({ B: "b" })] })
  .url("GET", "/a", a, { env: [app(["A"]), everything], on: [bus.event("x"), bus.event({ type: "y", source: "s" })] })
  .url("GET", "/b", b, { env, on });

// @ts-expect-error a single secret is read in code, not bound to the environment
new FunctionRouter("aws").url("GET", "/c", a, { env: app("A") });

// @ts-expect-error a path without /* needs the names to read
new FunctionRouter("aws").url("GET", "/e", a, { env: app });

// @ts-expect-error a trigger is bus.event(...), not a string
new FunctionRouter("aws").url("GET", "/d", a, { on: "x" });
