export function usedHelper() {
  return process.env.SIBLING_USED ?? "none";
}

export function loadsOther() {
  return import("./lazy-target.ts");
}
