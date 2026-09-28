/** Shared domain types (no zod here — DTOs live in ./schemas). */

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Numeric so a route can say `requireRoleAtLeast('admin')` without a set. */
export const ROLE_RANK: Record<Role, number> = {
  owner: 40,
  admin: 30,
  member: 20,
  viewer: 10,
};

export function hasRole(held: Role | null | undefined, required: Role): boolean {
  if (!held) {
    return false;
  }
  return ROLE_RANK[held] >= ROLE_RANK[required];
}

export const TENANT_STATUSES = ['active', 'suspended', 'cancelled'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
  plan: string;
  status: TenantStatus;
}

/** What a verified access token asserts about the caller. */
export interface Actor {
  userId: string;
  /** Refresh-token session id (used for revocation + audit). */
  sessionId: string;
  email: string;
  /** Tenant the token was minted for; must match the request's resolved tenant. */
  tenantId: string;
  role: Role;
  /** Issued-at/expiry in epoch seconds, per JWT spec. */
  iat: number;
  exp: number;
}

export interface RequestInfo {
  requestId: string;
  ip?: string;
  userAgent?: string;
  /** Set when the caller supplied an Idempotency-Key. */
  idempotencyKey?: string;
}
