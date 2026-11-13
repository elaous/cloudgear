import { helper } from "./lazy-helper.ts";

export default async function handler() {
  return { lazy: process.env.LAZY_VAR, helper: helper() };
}
