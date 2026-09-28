import { AppError, digestToken, randomToken, type PlanId, type Role } from '@saas/shared';
import type { Database } from '@saas/db';
import type { CacheStore } from '../../cache/store.js';
import type { QueueProducer } from '../../queue/producer.js';
import type { Requester } from '../../types.js';

export interface ProfileDto {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  role: Role;
  plan: PlanId;
}

export interface MemberDto {
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
  status: 'active' | 'invited' | 'disabled';
  joinedAt: string | null;
  lastSeenAt: string | null;
}

/**
 * Users and memberships.
 *
 * Two rules this module exists to enforce:
 *   - a user's *identity* row is global (one row per human, many tenants), so it
 *     is only ever mutated by the person it belongs to (`users_self_update`), and
 *     tenant-scoped listing goes through the membership join;
 *   - membership writes require a tenant admin — which the RLS policy also
 *     checks, so a route-level mistake is a 500-free no-op rather than a
 *     privilege grant.
 *
 * Invitations never carry a password or a session: the token is random, stored
 * only as a SHA-256 digest, and consumed inside `app.accept_invitation`, which is
 * where the "one owner per tenant" and quota invariants are checked.
 */
export class UserService {
  constructor(
    private readonly db: Database,
    private readonly cache: CacheStore,
    private readonly producer: QueueProducer,
  ) {}

  async profile(userId: string, tenantId: string): Promise<ProfileDto> {
    const key = `t:${tenantId}:profile:${userId}`;
    const hit = await this.cache.rawGet(key);
    if (hit !== undefined) {
      return JSON.parse(hit) as ProfileDto;
    }
    const rows = await this.db.withTenant(
      { tenantId, userId, readOnly: true },
      async (tx) =>
        (
          await tx.query<{
            id: string;
            email: string;
            display_name: string | null;
            created_at: Date;
            role: Role;
            plan: PlanId;
          }>(
            `SELECT u.id, u.email, u.display_name, u.created_at, m.role, t.plan
             FROM users u
             JOIN tenant_members m ON m.user_id = u.id AND m.tenant_id = $2
             JOIN tenants t ON t.id = m.tenant_id
            WHERE u.id = $1`,
            [userId, tenantId],
          )
        ).rows,
    );
    const row = rows[0];
    if (!row) {
      throw new AppError('NOT_FOUND', 'User not found in this workspace', 404);
    }
    const dto: ProfileDto = {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at.toISOString(),
      role: row.role,
      plan: row.plan,
    };
    await this.cache.rawSet(key, JSON.stringify(dto), 30_000);
    return dto;
  }

  async updateProfile(
    userId: string,
    tenantId: string,
    patch: { displayName?: string | undefined },
  ): Promise<void> {
    await this.db.withTenant({ tenantId, userId }, async (tx) => {
      await tx.query('UPDATE users SET display_name = coalesce($2, display_name) WHERE id = $1', [
        userId,
        patch.displayName ?? null,
      ]);
    });
    await this.cache.rawDel(`t:${tenantId}:profile:${userId}`);
  }

  async listMembers(
    tenantId: string,
    query: { limit: number; role?: Role | undefined },
  ): Promise<MemberDto[]> {
    const cached = await this.cache.getItem<MemberDto[]>(
      tenantId,
      'members',
      `list:${query.limit}:${query.role ?? ''}`,
    );
    if (cached) {
      return cached;
    }
    const rows = await this.db.withTenant(
      { tenantId, readOnly: true },
      async (tx) =>
        (
          await tx.query<{
            user_id: string;
            email: string;
            display_name: string | null;
            role: Role;
            status: 'active' | 'invited' | 'disabled';
            joined_at: Date | null;
            last_seen_at: Date | null;
          }>(
            `SELECT m.user_id, u.email, u.display_name, m.role, m.status, m.joined_at, m.last_seen_at
             FROM tenant_members m
             JOIN users u ON u.id = m.user_id
            WHERE m.tenant_id = app.current_tenant_id()
              AND ($2::text IS NULL OR m.role::text = $2)
            ORDER BY (m.role = 'owner') DESC, m.created_at ASC, m.user_id
            LIMIT $1`,
            [query.limit, query.role ?? null],
          )
        ).rows,
    );
    const data = rows.map((r) => ({
      userId: r.user_id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      status: r.status,
      joinedAt: r.joined_at ? r.joined_at.toISOString() : null,
      lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
    }));
    await this.cache.setItem(
      tenantId,
      'members',
      `list:${query.limit}:${query.role ?? ''}`,
      data,
      30_000,
    );
    return data;
  }

  async invite(input: {
    tenantId: string;
    tenantSlug: string;
    email: string;
    role: Role;
    actor: Requester;
  }): Promise<{ status: 'member' | 'invited'; inviteToken?: string }> {
    const existing = await this.db.query<{ user_id: string }>(
      'SELECT * FROM app.find_user_by_email($1)',
      [input.email],
    );
    const userId = existing.rows[0]?.user_id;

    if (userId) {
      try {
        await this.db.withTenant(
          { tenantId: input.tenantId, userId: input.actor.userId, role: input.actor.role },
          async (tx) => {
            await tx.query(
              `INSERT INTO tenant_members (tenant_id, user_id, role, status, invited_by, joined_at)
             VALUES (app.current_tenant_id(), $1, $2, 'active', $3, now())
             ON CONFLICT (tenant_id, user_id) DO UPDATE
               SET role = EXCLUDED.role, status = 'active', updated_at = now()`,
              [userId, input.role, input.actor.userId],
            );
            await tx.query('SELECT app.audit($1,$2,$3,$4::jsonb)', [
              'member.invited',
              'member',
              userId,
              JSON.stringify({ role: input.role, mode: 'existing-user' }),
            ]);
          },
        );
      } finally {
        await this.cache.invalidate(input.tenantId, 'members');
      }
      return { status: 'member' };
    }

    const token = randomToken(32);
    await this.db.withTenant(
      { tenantId: input.tenantId, userId: input.actor.userId, role: input.actor.role },
      async (tx) => {
        await tx.query(
          `INSERT INTO invitations (tenant_id, email, role, token_digest, invited_by, expires_at)
         VALUES (app.current_tenant_id(), $1, $2, $3, $4, now() + interval '7 days')
         ON CONFLICT (tenant_id, email_norm) WHERE accepted_at IS NULL
         DO UPDATE SET token_digest = EXCLUDED.token_digest, role = EXCLUDED.role,
                       expires_at = EXCLUDED.expires_at, created_at = now()`,
          [
            input.email,
            input.role === 'owner' ? 'admin' : input.role,
            digestToken(token),
            input.actor.userId,
          ],
        );
        await tx.query('SELECT app.audit($1,$2,$3,$4::jsonb)', [
          'member.invited',
          'invitation',
          input.email,
          JSON.stringify({ role: input.role, mode: 'new-user' }),
        ]);
      },
    );

    await this.producer
      .inviteEmail({
        tenantId: input.tenantId,
        tenantSlug: input.tenantSlug,
        invitedEmail: input.email,
        inviteToken: token,
        invitedBy: input.actor.userId,
      })
      .catch(() => undefined);

    return { status: 'invited', inviteToken: token };
  }

  async acceptInvitation(userId: string, token: string): Promise<{ tenantId: string; role: Role }> {
    // No tenant context exists yet — that is what we are establishing — so this
    // runs in a transaction that sets only `app.user_id`. `app.accept_invitation`
    // reads that GUC to bind the acceptance to the authenticated account; without
    // it, a leaked invite token would be redeemable by whoever presented it.
    const { rows } = await this.db
      .withTenant({ tenantId: '', userId }, (tx) =>
        tx.query<{ o_tenant_id: string; o_user_id: string; o_role: Role }>(
          'SELECT * FROM app.accept_invitation($1)',
          [digestToken(token)],
        ),
      )
      .catch((err: unknown) => {
        const e = err as Error & { code?: string };
        if (e.code === 'P0002') {
          throw new AppError('NOT_FOUND', 'Invitation not found or expired', 404);
        }
        if (e.code === '23505') {
          throw new AppError('CONFLICT', 'You already belong to this workspace', 409);
        }
        throw err;
      });

    const row = rows[0];
    if (!row) {
      throw new AppError('NOT_FOUND', 'Invitation not found or expired', 404);
    }
    if (row.o_user_id !== userId) {
      throw new AppError('FORBIDDEN', 'This invitation was issued to a different account', 403);
    }
    await this.cache.rawDel(`t:${row.o_tenant_id}:profile:${userId}`);
    await this.cache.rawDel(`tenant:id:${row.o_tenant_id}`);
    return { tenantId: row.o_tenant_id, role: row.o_role };
  }

  async changeRole(
    tenantId: string,
    targetUserId: string,
    role: Role,
    actor: Requester,
  ): Promise<void> {
    await this.db.withTenant({ tenantId, userId: actor.userId, role: actor.role }, async (tx) => {
      const res = await tx.query(
        `UPDATE tenant_members SET role = $2, updated_at = now()
          WHERE tenant_id = app.current_tenant_id() AND user_id = $1`,
        [targetUserId, role === 'owner' ? 'admin' : role],
      );
      if (res.rowCount === 0) {
        throw new AppError('NOT_FOUND', 'Member not found in this workspace', 404);
      }
      await tx.query('SELECT app.audit($1,$2,$3,$4::jsonb)', [
        'member.role_changed',
        'member',
        targetUserId,
        JSON.stringify({ role }),
      ]);
    });
    await this.cache.invalidate(tenantId, 'members');
    // The 10s authorisation memo must not survive a role change, or a demoted
    // admin keeps admin for the rest of the window.
    await this.cache.rawDel(`t:${tenantId}:member:${targetUserId}`);
  }

  async removeMember(tenantId: string, targetUserId: string, actor: Requester): Promise<void> {
    await this.db.withTenant({ tenantId, userId: actor.userId, role: actor.role }, async (tx) => {
      const res = await tx.query(
        `UPDATE tenant_members
            SET status = 'disabled', role = 'viewer', updated_at = now()
          WHERE tenant_id = app.current_tenant_id() AND user_id = $1 AND role <> 'owner'`,
        [targetUserId],
      );
      if (res.rowCount === 0) {
        throw new AppError('CONFLICT', 'The workspace owner cannot be removed', 409);
      }
      await tx.query('SELECT app.session_revoke_all($1,$2)', [targetUserId, tenantId]);
      await tx.query('SELECT app.audit($1,$2,$3,$4::jsonb)', [
        'member.removed',
        'member',
        targetUserId,
        '{}',
      ]);
    });
    await this.cache.invalidate(tenantId, 'members');
    await this.cache.rawDel(`t:${tenantId}:member:${targetUserId}`);
  }
}
