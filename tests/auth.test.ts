import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { jwtAuth } from "@cloudgear/functions";

describe("jwtAuth", () => {
  let server: ReturnType<typeof Bun.serve>;
  let issuer: string;
  let privateKey: CryptoKey;
  let otherKey: CryptoKey;
  let jwks: { keys: JWK[] };

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair("RS256")).privateKey;
    jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/.well-known/jwks.json" ? Response.json(jwks) : new Response("no", { status: 404 }),
    });
    issuer = server.url.origin;
  });
  afterAll(() => server.stop(true));

  const sign = (claims: Record<string, unknown>, options: { key?: CryptoKey; alg?: string; expires?: string; issuer?: string; audience?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: options.alg ?? "RS256", kid: "k1" })
      .setIssuer(options.issuer ?? issuer)
      .setAudience(options.audience ?? "app")
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime(options.expires ?? "5m")
      .sign(options.key ?? privateKey);
  const request = (token?: string, scheme = "Bearer") =>
    new Request("http://app/x", { headers: token ? { authorization: `${scheme} ${token}` } : {} });

  test("a custom header carries the bare token", async () => {
    const authenticate = jwtAuth({ issuer, audience: "app", header: "X-Auth-Token" });
    expect(authenticate.header).toBe("x-auth-token");
    expect(jwtAuth({ issuer }).header).toBe("authorization");
    const token = await sign({});
    const via = (value: string) => new Request("http://app/x", { headers: { "x-auth-token": value } });
    expect((await authenticate(via(token)))?.subject).toBe("user-1");
    expect((await authenticate(via(`Bearer ${token}`)))?.subject).toBe("user-1");
    expect(await authenticate(request(token))).toBeNull();
    expect(await authenticate(via("not-a-token"))).toBeNull();
  });

  test("accepts a valid token and exposes subject and claims", async () => {
    const authenticate = jwtAuth({ issuer, audience: "app" });
    const principal = await authenticate(request(await sign({ role: "admin" })));
    expect(principal).toMatchObject({ subject: "user-1", claims: { role: "admin", iss: issuer, aud: "app" } });
  });

  test("rejects missing, malformed, expired, mis-issued, wrong-audience and wrongly signed tokens", async () => {
    const authenticate = jwtAuth({ issuer, audience: "app" });
    expect(await authenticate(request())).toBeNull();
    expect(await authenticate(request("not-a-jwt"))).toBeNull();
    expect(await authenticate(request(await sign({}), "Basic"))).toBeNull();
    expect(await authenticate(request(await sign({}, { expires: "-1m" })))).toBeNull();
    expect(await authenticate(request(await sign({}, { issuer: "https://evil.example" })))).toBeNull();
    expect(await authenticate(request(await sign({}, { audience: "other" })))).toBeNull();
    expect(await authenticate(request(await sign({}, { key: otherKey })))).toBeNull();
  });

  test("an unsigned alg:none token is rejected", async () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: "user-1", iss: issuer, aud: "app" })}.`;
    expect(await jwtAuth({ issuer, audience: "app" })(request(token))).toBeNull();
  });

  test("an HS256 token is never accepted, even if signed with the public key material", async () => {
    const secret = new TextEncoder().encode(JSON.stringify(jwks.keys[0]));
    const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256", kid: "k1" }).setIssuer(issuer).setAudience("app").setSubject("user-1").setExpirationTime("5m").sign(secret);
    expect(await jwtAuth({ issuer, audience: "app" })(request(token))).toBeNull();
  });

  test("token-controlled oddities are 401s, not 503s: no kid against several keys, unsupported crit", async () => {
    const second = { ...(await exportJWK((await generateKeyPair("RS256")).publicKey)), kid: "k2", alg: "RS256", use: "sig" };
    const multi = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwks.keys[0], second] }) });
    try {
      const authenticate = jwtAuth({ issuer, audience: "app", jwksUri: multi.url.href });
      const noKid = await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience("app").setSubject("u").setExpirationTime("5m").sign(privateKey);
      expect(await authenticate(request(noKid))).toBeNull();

      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const crit = `${encode({ alg: "RS256", kid: "k1", crit: ["foo"], foo: 1 })}.${encode({ sub: "u", iss: issuer, aud: "app" })}.AAAA`;
      expect(await jwtAuth({ issuer, audience: "app" })(request(crit))).toBeNull();
    } finally {
      multi.stop(true);
    }
  });

  test("a token without a subject is rejected", async () => {
    const token = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience("app").setExpirationTime("5m").sign(privateKey);
    expect(await jwtAuth({ issuer, audience: "app" })(request(token))).toBeNull();
  });

  test("a JWKS endpoint that fails or returns garbage throws, so the router answers 503 not 401", async () => {
    const broken = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/error" ? new Response("boom", { status: 500 }) : new Response("this is not json", { status: 200 }),
    });
    try {
      const token = await sign({});
      for (const path of ["/error", "/garbage"]) {
        const authenticate = jwtAuth({ issuer, audience: "app", jwksUri: new URL(path, broken.url).href });
        await expect(authenticate(request(token))).rejects.toThrow();
      }
    } finally {
      broken.stop(true);
    }
  });

  test("an unreachable JWKS endpoint throws instead of denying", async () => {
    const authenticate = jwtAuth({ issuer, audience: "app", jwksUri: "http://127.0.0.1:1/jwks.json" });
    await expect(authenticate(request(await sign({})))).rejects.toThrow();
  });
});
