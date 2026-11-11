import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { FunctionRouter } from "@cloudgear/functions";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("router.fetch(name, opts)", () => {
  let router: FunctionRouter | undefined;
  afterEach(() => router?.stop());

  const serve = () => {
    router = new FunctionRouter("aws", { mode: "local" })
      .url("GET", "/items", (input: { q?: string }) => ({ q: input.q ?? null }), { name: "api-items" })
      .url("GET", "/items/{id}", (input: { id: string }) => ({ id: input.id }), { name: "item" })
      .url("POST", "/echo", () => ({}), { name: "echo" });
    router.listen(0);
    return router;
  };

  test("calls a route by name with a query", async () => {
    const res = await serve().fetch("api-items", { query: { q: "cats" } });
    expect(await res.json()).toEqual({ q: "cats" });
  });

  test("fills path parameters and encodes them", async () => {
    const res = await serve().fetch("item", { params: { id: "a b" } });
    expect(await res.json()).toEqual({ id: "a b" });
  });

  test("a missing path parameter or an unknown name is an error", async () => {
    const r = serve();
    await expect(r.fetch("item")).rejects.toThrow(/needs the path parameter "id"/);
    await expect(r.fetch("nope")).rejects.toThrow(/No route named "nope"; known routes: api-items/);
  });

  test("writes carry x-amz-content-sha256, reads do not", async () => {
    const seen: { headers: Headers; url: string; text: string }[] = [];
    const server = Bun.serve({ port: 0, fetch: async (req) => { seen.push({ headers: req.headers, url: req.url, text: await req.text() }); return new Response("ok"); } });
    const origin = server.url.origin;
    try {
      const r = new FunctionRouter("aws", { mode: "remote", endpoints: { "POST /echo": origin, "GET /items": origin }, authenticated: "none" })
        .url("POST", "/echo", () => ({}), { name: "echo" })
        .url("GET", "/items", () => ({}), { name: "items" });
      await r.fetch("echo", { method: "POST", body: { a: 1 }, headers: { "x-extra": "1" } });
      await r.fetch("echo", { method: "post", body: "raw text" });
      await r.fetch("echo", { method: "POST" });
      await r.fetch("items", { query: new URLSearchParams({ x: "1" }) });
      expect(seen[0]!.headers.get("x-amz-content-sha256")).toBe(sha('{"a":1}'));
      expect(seen[0]!.headers.get("content-type")).toBe("application/json");
      expect(seen[0]!.headers.get("x-extra")).toBe("1");
      expect(seen[0]!.text).toBe('{"a":1}');
      expect(seen[1]!.headers.get("x-amz-content-sha256")).toBe(sha("raw text"));
      expect(seen[2]!.headers.get("x-amz-content-sha256")).toBe(sha(""));
      expect(seen[3]!.headers.get("x-amz-content-sha256")).toBeNull();
      expect(new URL(seen[3]!.url).search).toBe("?x=1");
    } finally {
      server.stop(true);
    }
  });

  test("a body on GET is refused, and fetch(Request) still serves", async () => {
    const r = serve();
    await expect(r.fetch("api-items", { body: "x" })).rejects.toThrow(/GET request cannot have a body/);
    const res = await r.fetch(new Request("http://app/items?q=z"));
    expect(await res.json()).toEqual({ q: "z" });
  });
});
