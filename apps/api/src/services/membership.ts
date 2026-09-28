import type { PlanId, Role } from '@saas/shared';
import type { FastifyInstance } from 'fastify';

export interface MembershipInfo {
  role: Role;
  plan: PlanId;
  tenantStatus: 'active' | 'suspended' | 'cancelled';
}

export interface MembershipPort {
  /** null when the caller is not an *active* member of the tenant. */
  lookup(userId: string, tenantId: string): Promise<MembershipInfo | null>;
  /** Drop the memo: role change, removal, suspension, plan change. */
  invalidate(userId: string, tenantId: string): Promise<void>;
  invalidateTenant(tenantId: string): Promise<void>;
}

interface Row {
  role: Role;
  status: 'active' | 'invited' | 'disabled';
  tenant_plan: PlanId;
  tenant_status: 'active' | 'suspended' | 'cancelled';
}

/**
 * Membership is the authorisation source of truth, and it is read on *every*
 * authenticated request — so it gets a short, explicit memo rather than being
 * "just a fast query".
 *
 * Design notes:
 *   - TTL is 10s and the key lives in the *cache* Redis (allkeys-lru): the worst
 *     case of a stale memo is a role change taking 10s to propagate, which we
 *     document and which `invalidate()` collapses to ~0 for the paths we control
 *     (role update, member removal, tenant suspension, plan change).
 *   - A lost Redis means a Postgres lookup per request, not a security hole:
 *     `KvClient.get` swallows its own errors and returns a miss.
 *   - `plan` is fetched alongside membership because plan changes must not
 *     require a second tenant read; the tenant row is already policy-protected.
 */
export class CachedMembershipService implements MembershipPort {
  private static readonly TTL_MS = 10_000;

  constructor(private readonly app: FastifyInstance) {}

  private key(userId: string, tenantId: string): string {
    return `t:${tenantId}:member:${userId}`;
  }

  async lookup(userId: string, tenantId: string): Promise<MembershipInfo | null> {
    const k = this.key(userId, tenantId);
    const hit = await this.app.cache.rawGet(k);
    if (hit !== undefined) {
      if (hit === NEG) {
        return null;
      }
      const parsed = JSON.parse(hit) as MembershipInfo;
      return { ...parsed };
    }

    const { rows } = await this.app.db.query<Row>('SELECT * FROM app.membership_role($1,$2)', [
      userId,
      tenantId,
    ]);
    const row = rows[0];
    if (!row || row.status !== 'active') {
      await this.app.cache.rawSet(k, NEG, 2_000);
      return null;
    }
    const info: MembershipInfo = {
      role: row.role,
      plan: row.tenant_plan,
      tenantStatus: row.tenant_status,
    };
    await this.app.cache.rawSet(k, JSON.stringify(info), CachedMembershipService.TTL_MS);
    return info;
  }

  async invalidate(userId: string, tenantId: string): Promise<void> {
    await this.app.cache.rawDel(this.key(userId, tenantId));
  }

  /**
   * Plan changes affect every member of the tenant. We do not enumerate member
   * keys (that is a SCAN); instead the *tenant* memo is bumped and member memos
   * age out within 10s. The plan label on metrics and the limiter geometry both
   * come from `req.tenant.plan`, which is re-derived from membership on the
   * next request.
   */
  async invalidateTenant(tenantId: string): Promise<void> {
    await this.app.cache.rawDel(`tenant:id:${tenantId}`);
    await this.app.cache.rawDel(`tenant:slug:${tenantId}`);
    await this.app.cache.invalidate(tenantId, 'members');
  }
}

const NEG = '__nonmember__';
