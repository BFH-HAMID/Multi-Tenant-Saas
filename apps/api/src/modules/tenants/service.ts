import { AppError, conflict, newTenantId, planLimits, type PlanId, type Role } from '@saas/shared';
import type { Database } from '@saas/db';
import type { CacheStore } from '../../cache/store.js';
import type { Requester, ResolvedTenant } from '../../types.js';

export interface TenantSummaryRow {
  id: string;
  slug: string;
  name: string;
  plan: PlanId;
  status: 'active' | 'suspended' | 'cancelled';
  role: Role;
  memberCount: number;
  projectCount: number;
}

export interface TenantSettings {
  allowSignup?: boolean;
  requireMfaForAdmins?: boolean;
  [k: string]: unknown;
}

/**
 * Tenant operations that are *not* plain RLS-scoped row reads: provisioning,
 * plan changes, settings. Everything else about the current tenant is served
 * from `req.tenant`, resolved once per request (hooks/tenant.ts).
 *
 * The plan change is the interesting one: `tenants.plan` selects that tenant's
 * own limiter geometry, quotas and cache TTLs, so the app role must not be able
 * to PATCH it. `app.update_tenant_plan` is a definer function that (a) is the
 * only write path for the column, and (b) refuses a downgrade that would leave
 * the tenant over quota while holding the row lock.
 */
export class TenantService {
  constructor(
    private readonly db: Database,
    private readonly cache: CacheStore,
  ) {}

  /** All workspaces the caller belongs to — the tenant switcher's data source. */
  async listForUser(userId: string): Promise<TenantSummaryRow[]> {
    const { rows } = await this.db.query<{
      tenant_id: string;
      slug: string;
      name: string;
      plan: PlanId;
      status: 'active' | 'suspended' | 'cancelled';
      role: Role;
      member_count: string;
      project_count: string;
    }>('SELECT * FROM app.tenants_for_user($1)', [userId]);

    return rows.map((r) => ({
      id: r.tenant_id,
      slug: r.slug,
      name: r.name,
      plan: r.plan,
      status: r.status,
      role: r.role,
      memberCount: Number(r.member_count),
      projectCount: Number(r.project_count),
    }));
  }

  async create(
    userId: string,
    input: { name: string; slug: string; plan: PlanId },
  ): Promise<{ id: string; role: Role; plan: PlanId }> {
    const tenantId = newTenantId();
    try {
      const { rows } = await this.db.query<{ o_tenant_id: string; o_role: Role; o_plan: PlanId }>(
        'SELECT * FROM app.create_tenant_for_user($1,$2,$3,$4,$5)',
        [tenantId, input.slug, input.name, input.plan, userId],
      );
      const row = rows[0];
      if (!row) {
        throw new AppError('INTERNAL', 'tenant creation returned no row', 500);
      }
      return { id: row.o_tenant_id, role: row.o_role, plan: row.o_plan };
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === '23505') {
        throw conflict('That workspace URL is already taken');
      }
      if (e.code === '22023') {
        throw new AppError('VALIDATION_FAILED', e.message, 422);
      }
      throw err;
    }
  }

  async current(tenant: ResolvedTenant): Promise<
    TenantSummaryRow & {
      retentionDays: number;
      settings: TenantSettings;
      limits: ReturnType<typeof planLimits>;
    }
  > {
    const rows = await this.db.withTenant(
      { tenantId: tenant.id, readOnly: true },
      async (tx) =>
        (
          await tx.query<{
            id: string;
            slug: string;
            name: string;
            plan: PlanId;
            status: 'active' | 'suspended' | 'cancelled';
            retention_days: number;
            settings: TenantSettings;
            member_count: string;
            project_count: string;
            role: Role;
          }>(
            `SELECT t.id, t.slug, t.name, t.plan, t.status, t.retention_days, t.settings,
                  coalesce(s.member_count, 0)::text AS member_count,
                  coalesce(s.project_count, 0)::text AS project_count,
                  m.role
             FROM tenants t
        LEFT JOIN tenant_stats s ON s.tenant_id = t.id
        LEFT JOIN tenant_members m ON m.tenant_id = t.id AND m.user_id = app.current_user_id()
            WHERE t.id = app.current_tenant_id()`,
          )
        ).rows,
    );
    const row = rows[0];
    if (!row) {
      throw new AppError('TENANT_NOT_FOUND', 'Workspace not found', 404);
    }
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      plan: row.plan,
      status: row.status,
      role: row.role ?? 'member',
      memberCount: Number(row.member_count),
      projectCount: Number(row.project_count),
      retentionDays: row.retention_days,
      settings: row.settings ?? {},
      limits: planLimits(row.plan),
    };
  }

  async updateSettings(
    tenant: ResolvedTenant,
    actor: Requester,
    patch: {
      name?: string | undefined;
      settings?: TenantSettings | undefined;
      retentionDays?: number | undefined;
    },
  ): Promise<void> {
    await this.db.withTenant(
      { tenantId: tenant.id, userId: actor.userId, role: actor.role },
      async (tx) => {
        await tx.query(
          `UPDATE tenants
            SET name = coalesce($2, name),
                settings = coalesce($3::jsonb, settings),
                retention_days = coalesce($4, retention_days)
          WHERE id = app.current_tenant_id()`,
          [
            tenant.id,
            patch.name ?? null,
            patch.settings ? JSON.stringify(patch.settings) : null,
            patch.retentionDays ?? null,
          ],
        );
        await tx.query('SELECT app.audit($1,$2,$3,$4::jsonb)', [
          'tenant.settings_updated',
          'tenant',
          tenant.id,
          JSON.stringify({ fields: Object.keys(patch) }),
        ]);
      },
    );
    // The tenant memo must go, or the next 60s of requests carry the old name —
    // and, for a plan change, the old limiter geometry.
    await this.invalidateTenantCache(tenant.id, tenant.slug);
  }

  async changePlan(
    tenant: ResolvedTenant,
    plan: PlanId,
    actor: Requester,
  ): Promise<{ plan: PlanId; limits: ReturnType<typeof planLimits> }> {
    const { rows } = await this.db.query<{ o_ok: boolean; o_reason: string | null }>(
      'SELECT * FROM app.update_tenant_plan($1,$2,$3)',
      [tenant.id, plan, actor.userId],
    );
    const row = rows[0];
    if (!row?.o_ok) {
      throw new AppError(
        'PLAN_LIMIT_EXCEEDED',
        row?.o_reason ?? 'That plan change is not possible',
        409,
        {
          details: { requested: plan, current: tenant.plan },
        },
      );
    }
    await this.invalidateTenantCache(tenant.id, tenant.slug);
    // Rate-limit geometry for this tenant is derived from the plan on every
    // request; the *bucket* itself keeps its current fill level, which is the
    // right behaviour (an upgrade does not hand out a fresh full burst).
    return { plan, limits: planLimits(plan) };
  }

  async invalidateTenantCache(id: string, slug: string): Promise<void> {
    await this.cache.rawDel(`tenant:id:${id}`);
    await this.cache.rawDel(`tenant:slug:${slug}`);
    await this.cache.invalidate(id, 'members');
    await this.cache.invalidate(id, 'tenant');
  }
}
