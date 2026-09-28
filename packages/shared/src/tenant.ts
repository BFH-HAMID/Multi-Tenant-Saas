/**
 * Tenant resolution: header, subdomain, or JWT claim.
 *
 * Precedence (documented in ARCHITECTURE.md §Tenancy):
 *   1. `X-Tenant-Id` / `X-Tenant-Slug` header — API clients, CLI, tests.
 *   2. subdomain of the host — browser session (`acme.api.example.com`).
 *   3. `tid` claim in the access token — set at login; lets a SPA that cannot
 *      control Host still work, and lets us reject a mismatch (defense in
 *      depth: an attacker cannot pair a valid token with someone else's
 *      tenant header unless they hold a membership in that tenant too).
 *
 * Everything downstream (RLS GUC, cache keys, rate-limit keys, queue jobs)
 * consumes the *resolved* tenant, never the raw header. That single funnel is
 * what makes the isolation story auditable.
 */

export const TENANT_ID_HEADER = 'x-tenant-id';
export const TENANT_SLUG_HEADER = 'x-tenant-slug';
export const TENANT_ID_CLAIM = 'tid';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Strip the tenant label off a host, or return null when it is not a subdomain. */
export function tenantFromHost(
  host: string | undefined,
  opts: { baseDomains: string[]; allowLocalhostLabel?: boolean },
): string | null {
  if (!host) {
    return null;
  }
  const bare = host.split(':')[0]!.toLowerCase();
  if (opts.allowLocalhostLabel && (bare === 'localhost' || bare === '127.0.0.1')) {
    return null;
  }
  for (const base of opts.baseDomains) {
    const suffix = `.${base.toLowerCase()}`;
    if (bare.endsWith(suffix)) {
      const label = bare.slice(0, -suffix.length);
      if (label.length > 0 && !label.includes('.') && isSlug(label)) {
        return label;
      }
      return null;
    }
  }
  return null;
}

export interface RawTenantHint {
  headerTenantId?: string;
  headerSlug?: string;
  host?: string;
  tokenTenantId?: string;
}

export type TenantHint =
  | { kind: 'id'; value: string; source: 'header' | 'token' }
  | { kind: 'slug'; value: string; source: 'header' | 'subdomain' }
  | { kind: 'none' };

/** Parse-only: validation against the tenants table happens in the middleware. */
export function extractTenantHint(
  raw: RawTenantHint,
  opts: { baseDomains: string[]; allowLocalhostLabel?: boolean },
): TenantHint {
  if (raw.headerTenantId && isUuid(raw.headerTenantId)) {
    return { kind: 'id', value: raw.headerTenantId.toLowerCase(), source: 'header' };
  }
  if (raw.headerSlug && isSlug(raw.headerSlug)) {
    return { kind: 'slug', value: raw.headerSlug, source: 'header' };
  }
  const sub = tenantFromHost(raw.host, opts);
  if (sub) {
    return { kind: 'slug', value: sub, source: 'subdomain' };
  }
  if (raw.tokenTenantId && isUuid(raw.tokenTenantId)) {
    return { kind: 'id', value: raw.tokenTenantId.toLowerCase(), source: 'token' };
  }
  return { kind: 'none' };
}

/** Slug used for the `?tenant=` demo mode and tests; never trust it blindly. */
export function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function tenantDebug(hint: TenantHint): Record<string, string> {
  return hint.kind === 'none'
    ? { tenantHint: 'none' }
    : { [hint.kind]: hint.value, via: hint.source };
}
