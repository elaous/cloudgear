import { response, type RequestContext } from "@cloudgear/functions";

export { grant, permissions, policy } from "@cloudgear/blob";
export type { BlobAccess, PolicyOptions } from "@cloudgear/blob";
export { cron, jwtAuth, response, schedule } from "@cloudgear/functions";
export type { CronSchedule, Principal, RequestContext } from "@cloudgear/functions";

export type Check<I = any> = (input: I, context: RequestContext) => boolean | Promise<boolean>;

export const authenticated =
  (): Check =>
  (_input, context) =>
    context.auth !== undefined;

// A claim equal to `expected`, accepted by the predicate `expected`, or present when omitted.
export const claim =
  (name: string, expected?: string | number | boolean | null | ((value: unknown) => boolean)): Check =>
  (_input, context) => {
    if (!context.auth || !Object.hasOwn(context.auth.claims, name)) return false;
    const value = context.auth.claims[name];
    if (expected === undefined) return true;
    return typeof expected === "function" ? Boolean(expected(value)) : value === expected;
  };

export const allOf =
  (...checks: Check[]): Check =>
  async (input, context) => {
    for (const check of checks) if (!(await check(input, context))) return false;
    return true;
  };

export const anyOf =
  (...checks: Check[]): Check =>
  async (input, context) => {
    for (const check of checks) if (await check(input, context)) return true;
    return false;
  };

export const not =
  (check: Check): Check =>
  async (input, context) =>
    !(await check(input, context));

type Routed = (this: any, input: any, context: RequestContext) => unknown;

// Runs the method only when every check passes: 401 without a caller, 403 with one the checks refuse.
export function guard(...checks: Check[]) {
  const allowed = allOf(...checks);
  return <T extends Routed>(method: T, _context: ClassMethodDecoratorContext): T =>
    async function (this: unknown, input: unknown, context: RequestContext = {}) {
      if (await allowed(input, context)) return method.call(this, input, context);
      return context.auth
        ? response({ error: "Forbidden" }, { status: 403 })
        : response({ error: "Unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
    } as T;
}
