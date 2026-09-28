import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Actor, Role } from '@saas/shared';

/**
 * Access tokens are short-lived (15 min) HMAC-signed JWTs; refresh tokens are
 * opaque 256-bit random strings whose SHA-256 digest lives in Postgres.
 *
 * Why HS256 and not RS256/EdDSA: the only verifier today is this API, so a
 * private key buys nothing and asymmetric signing adds a slow verify path and
 * a key-distribution story we would have to invent. The escape hatch is written
 * down (see docs/adr): if a second service (or a browser-facing edge) has to
 * verify without the signing secret, we move to EdDSA + JWKS at `/\.well-known/
 * jwks.json` and keep the token shape. `iss`/`aud`/`kid` are already in the
 * payload so that migration is a config change, not a format change.
 *
 * `tid` + `role` are in the token so a request needs *no* DB round trip for
 * authorisation on read paths; membership revocation is enforced by (a) the
 * 15-minute TTL, (b) the session row — revoking a family kills refresh, and
 * (c) `app.tenant_role` in the transaction, which the RLS policies also check.
 * That triple is the honest answer to "what happens between revocation and
 * expiry": up to 15 minutes of a still-valid access token, mitigated by
 * per-request tenant-scoped policies that cannot cross tenants.
 */
export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  tid: string;
  role: Role;
  sid: string;
  email: string;
  plan?: string;
}

export interface TokenIssuer {
  sign(
    actor: Omit<Actor, 'iat' | 'exp'>,
  ): Promise<{ accessToken: string; expiresInSeconds: number }>;
  verify(token: string): Promise<Actor>;
}

export class TokenError extends Error {
  constructor(
    readonly kind: 'expired' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

export function createTokenIssuer(opts: {
  secret: string;
  issuer: string;
  audience: string;
  accessTtlSec: number;
  keyId?: string;
}): TokenIssuer {
  const key = new TextEncoder().encode(opts.secret);

  return {
    async sign(actor) {
      const iat = Math.floor(Date.now() / 1000);
      const exp = iat + opts.accessTtlSec;
      const payload: AccessTokenClaims = {
        sub: actor.userId,
        tid: actor.tenantId,
        role: actor.role,
        sid: actor.sessionId,
        email: actor.email,
        iss: opts.issuer,
        aud: opts.audience,
        iat,
        exp,
      };
      const accessToken = await new SignJWT({ ...payload })
        .setProtectedHeader({
          alg: 'HS256',
          typ: 'JWT',
          ...(opts.keyId ? { kid: opts.keyId } : {}),
        })
        .sign(key);
      return { accessToken, expiresInSeconds: opts.accessTtlSec };
    },

    async verify(token: string): Promise<Actor> {
      let payload: AccessTokenClaims;
      try {
        ({ payload } = await jwtVerify(token, key, {
          issuer: opts.issuer,
          audience: opts.audience,
          clockTolerance: 5, // small, for skewed pods; never 60 to "fix" a real skew
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new TokenError(/exp/i.test(msg) ? 'expired' : 'invalid', msg);
      }
      const p = payload as AccessTokenClaims;
      if (typeof p.sub !== 'string' || typeof p.tid !== 'string' || typeof p.sid !== 'string') {
        throw new TokenError('invalid', 'token is missing required claims');
      }
      return {
        userId: p.sub,
        tenantId: p.tid,
        sessionId: p.sid,
        email: p.email ?? '',
        role: (p.role ?? 'member') as Role,
        iat: Number(p.iat ?? 0),
        exp: Number(p.exp ?? 0),
      };
    },
  };
}
