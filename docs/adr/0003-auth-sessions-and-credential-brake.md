# ADR-0003: Auth — JWT access, rotating refresh, RBAC, and the layered credential brake

**Status:** accepted

## Context

Auth in a multi-tenant API has three separable problems: identifying a user,
identising _which tenant's_ data they may touch, and keeping credential
endpoints from becoming the cheapest DoS on the platform.

## Decision

**Sessions.** Short-lived JWT **access tokens (HS256, 15 min)** carrying
`sub` (user), `tid` (tenant), `role` — no session table on the hot path — plus
server-side **rotating refresh tokens (30 days, argon2id-hashed at rest in
`refresh_tokens`)**. Rotation is _detected_: presenting an already-rotated
refresh token revokes the entire token family (`auth_events_total{event=
"reuse_detected"}`, a critical alert) — the textbook stolen-token response.

**Passwords.** argon2id via `@node-rs/argon2`, 19 MiB / t=2 / p=1, with the
API's key-material pre-hash (argon2 sees the digest of the normalised
password, never the password). Login compares against a dummy hash when the
user does not exist, so response time does not oracle user existence.

**Tenancy binding.** The tenant hook runs _after_ token verification and
cross-checks the token's `tid` against the resolved tenant (header/subdomain):
**a valid token cannot be aimed at a different workspace** — 403, `tenant_mismatch`
counter, never a silent switch.

**RBAC.** Roles per tenant (`owner > admin > member > viewer`) stored in
`tenant_members`, surfaced through the request transaction as the
`app.tenant_role` GUC, so SQL triggers can enforce role rules too. Permission
checks are data-driven at route registration; every route declares its
requirement (a contract test walks the route tree and fails a route that
forgot).

**Credential brake, layered** (the reason `ANON_BUCKET` is deprecated):

1. the edge (nginx limit-rps / ingress annotation) applies a coarse per-IP
   rate — it must stay _looser_ than the app's buckets so edge rejections
   never pollute `ratelimit_decisions_total`;
2. the app applies the plan's `auth` bucket **plus an IP-scoped mirror**
   (`rl:ip:{ip}:auth`) before tenant resolution, so credential stuffing is
   braked even when the attacker has no tenant at all;
3. argon2id cost itself is the third brake.

## Consequences

- Access-token revocation is not instant (15 min window) — acceptable for
  this product tier; instant revocation would mean a session store on the hot
  path, which is precisely what the JWT design avoids.
- Refresh rotation needs one DB write per renewal — fine (renewals are rare
  compared to requests) and it is what makes reuse detection possible.
- The layered brake means a 429 can come from the edge or the app; both are
  byte-compatible problem+json, and `X-RateLimit-Source` says which layer
  answered, so a client (or a load test) never has to guess.
