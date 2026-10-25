import { FunctionRouter } from "@cloudgear/functions";

export function item(input: { id: string }) {
  return input;
}

// @ts-expect-error the route declares {other}, which item's input lacks
new FunctionRouter("aws").add("GET", "/items/{other}", item);
