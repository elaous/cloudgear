import { FunctionRouter } from "@cloudgear/functions";

function helper() {
  return process.env.HELPER_VAR;
}

export async function other() {
  return process.env.OTHER_FN_VAR;
}

export async function caller() {
  return { h: helper(), o: await other() };
}

export async function api() {
  process.env.TZ = "UTC";
  process.env.ASSIGNED_ONLY = "x";
  process.env.DEFAULTED ??= "d";
  delete process.env.DELETED;
  const mode = process.env.NODE_ENV === "production";
  const debug = Boolean(process.env.DEBUG_FLAG);
  const trimmed = process.env.TRIMMED?.trim();
  const same = process.env.SAME !== undefined;
  const has = process.env.hasOwnProperty("PROTOTYPE_CALL");
  if (!process.env.MUST_HAVE) throw new Error("MUST_HAVE is required");
  if (!process.env.SOFT_CHECK) console.log("soft");
  const aliased = process.env;
  const viaAlias = aliased.ALIASED;
  const viaGlobal = globalThis.process.env.VIA_GLOBAL;
  const cast = (process.env as Record<string, string>).CAST;
  const bang = process.env.BANG!;
  return { mode, debug, trimmed, same, has, viaAlias, viaGlobal, cast, bang };
}

export class Service {
  private readonly key = process.env.CLASS_FIELD;
  async handle() {
    return this.key;
  }
}

export const service = new Service();

new FunctionRouter("aws")
  .url("GET", "/api", api)
  .url("GET", "/caller", caller)
  .url("GET", "/other", other)
  .url("GET", "/service", service.handle);
