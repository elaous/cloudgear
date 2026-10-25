import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { Principal } from "./http";

export type Authenticator = (req: Request) => Principal | null | undefined | Promise<Principal | null | undefined>;

export interface JwtAuthOptions {
  issuer: string;
  // Strongly recommended: without it any token from this issuer is accepted.
  audience?: string | string[];
  // Defaults to `<issuer>/.well-known/jwks.json` (Cognito, Clerk, Auth0 style issuers).
  jwksUri?: string;
  clockToleranceSeconds?: number;
  // Header carrying the token. Defaults to `authorization` (`Bearer <jwt>`); any other header holds
  // the bare token (a `Bearer ` prefix is tolerated). `cloudgear generate` reads it, so it MUST be a literal.
  header?: string;
}

export type JwtAuthenticator = Authenticator & { readonly header: string };

// Asymmetric algorithms only, so a token can never be validated against a shared secret.
const ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

// Only these mean "this token is bad"; anything else (JWKS outage, bad JWKS body) is an infrastructure failure.
const INVALID_TOKEN = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

// Verifies `Authorization: Bearer <jwt>` against the issuer's JWKS. Invalid tokens yield null (401);
// a JWKS endpoint that is unreachable or returns garbage throws (the router answers 503).
export function jwtAuth(options: JwtAuthOptions): JwtAuthenticator {
  const header = (options.header ?? "authorization").toLowerCase();
  const jwksUri = options.jwksUri ?? `${options.issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
  const keys = createRemoteJWKSet(new URL(jwksUri));

  const authenticate: Authenticator = async (req) => {
    const value = req.headers.get(header)?.trim() ?? "";
    const token = header === "authorization" ? /^Bearer\s+(\S+)$/i.exec(value)?.[1] : /^(?:Bearer\s+)?(\S+)$/i.exec(value)?.[1];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ALGORITHMS,
        clockTolerance: options.clockToleranceSeconds,
      });
      if (typeof payload.sub !== "string" || !payload.sub) return null;
      return { subject: payload.sub, claims: payload as Record<string, unknown> };
    } catch (err) {
      if (INVALID_TOKEN.some((invalid) => err instanceof invalid)) return null;
      throw err;
    }
  };
  return Object.assign(authenticate, { header });
}
