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

// Equality, predicate, or presence when omitted.
export const claim =
  (name: string, expected?: string | number | boolean | null | ((value: unknown) => boolean)): Check =>
  (_input, context) => {
    const claims = context.auth?.claims;
    if (!claims || !Object.hasOwn(claims, name)) return false;
    const value = claims[name];
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

type Routed = (this: any, ...args: any[]) => unknown;

// Runs only when all checks pass: 401 without caller, 403 otherwise.
// Context is the last argument; input is the first.
// Async wrapper; keeps the method name.
export function guard(...checks: Check[]) {
  const allowed = allOf(...checks);
  return <T extends Routed>(method: T, _context: ClassMethodDecoratorContext): T => {
    const wrapper = async function (this: unknown, ...args: unknown[]) {
      const context = (args.length > 1 ? args[args.length - 1] : undefined) as RequestContext | undefined;
      if (await allowed(args[0], context ?? {})) return method.apply(this, args);
      return context?.auth
        ? response({ error: "Forbidden" }, { status: 403 })
        : response({ error: "Unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
    };
    Object.defineProperty(wrapper, "name", { value: method.name });
    return wrapper as unknown as T;
  };
}
