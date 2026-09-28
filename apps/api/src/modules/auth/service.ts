import {
  AppError,
  digestToken,
  randomToken,
  tenantNotFound,
  unauthenticated,
  type PlanId,
} from '@saas/shared';
import type { Database } from '@saas/db';
import type { AppConfig } from '../../config/index.js';
import type { PasswordService } from './passwords.js';
import type { TokenIssuer } from './tokens.js';
import type { QueueProducer } from '../../queue/producer.js';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  tenant: { id: string; slug: string; plan: PlanId; role: string };
}

interface UserRow {
  user_id: string;
  email: string;
  password_hash: string;
  disabled: boolean;
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  plan: PlanId;
  status: 'active' | 'suspended' | 'cancelled';
  retention_days: number;
}

interface MembershipRow {
  role: 'owner' | 'admin' | 'member' | 'viewer';
  status: 'active' | 'invited' | 'disabled';
  tenant_plan: PlanId;
  tenant_status: 'active' | 'suspended' | 'cancelled';
}

/**
 * Auth orchestration. Everything that must be atomic (rotation, family revoke,
 * quota-checked membership) is a single SECURITY DEFINER call into Postgres —
 * see db/migrations/0008_session_functions.sql for why.
 */
export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenIssuer,
    private readonly cfg: AppConfig,
    private readonly producer: QueueProducer,
    private readonly log: { info(o: object, m?: string): void; warn(o: object, m?: string): void },
  ) {}

  async register(input: {
    tenant: { name: string; slug: string; plan: PlanId };
    user: { email: string; password: string; displayName?: string | undefined };
    signupSource?: string | undefined;
    ip?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<{ tokens: SessionTokens; tenant: TenantRow }> {
    const tenantId = uuid();
    const userId = uuid();
    const passwordHash = await this.passwords.hash(input.user.password);

    try {
      await this.db.query(`SELECT app.register_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
        tenantId,
        input.tenant.slug,
        input.tenant.name,
        input.tenant.plan,
        userId,
        input.user.email,
        passwordHash,
        input.user.displayName ?? null,
        input.signupSource ?? null,
      ]);
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === '23505') {
        // Two different uniqueness sources collide on one SQLSTATE; the client
        // needs to know which one to fix, and the message from our RAISE is
        // already specific and safe to surface.
        throw new AppError('CONFLICT', friendlyConflict(e.message), 409);
      }
      if (e.code === '22023') {
        throw new AppError('VALIDATION_FAILED', e.message, 422);
      }
      throw err;
    }

    const tenant = await this.loadTenantById(tenantId);
    const session = await this.issueSession({
      userId,
      email: input.user.email,
      tenant,
      role: 'owner',
      ip: input.ip,
      userAgent: input.userAgent,
    });

    await this.producer
      .welcomeEmail({
        tenantId,
        tenantSlug: tenant.slug,
        userId,
        email: input.user.email,
        displayName: input.user.displayName ?? null,
      })
      .catch((err: unknown) => {
        // The account exists; a welcome email is not worth failing the signup.
        this.log.warn({ err: String(err) }, 'welcome email enqueue failed');
      });

    return { tokens: session, tenant };
  }

  async login(input: {
    email: string;
    password: string;
    tenantSlug?: string | undefined;
    ip?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<
    | { tokens: SessionTokens }
    | {
        needsTenantChoice: {
          candidates: Array<{ id: string; slug: string; name: string; role: string }>;
        };
      }
  > {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM app.find_user_by_email($1)', [
      input.email,
    ]);
    const user = rows[0];

    if (!user || user.disabled) {
      // Constant-work on the "no such user" path: hash a dummy so timing does
      // not tell an enumerator which emails exist.
      await this.passwords.verify(DUMMY_HASH, input.password);
      throw unauthenticated('Invalid email or password');
    }

    const ok = await this.passwords.verify(user.password_hash, input.password);
    if (!ok) {
      throw unauthenticated('Invalid email or password');
    }

    if (await this.passwords.needsUpgrade(user.password_hash)) {
      const fresh = await this.passwords.hash(input.password);
      await this.db.query(
        'UPDATE users SET password_hash = $2, password_params = $3 WHERE id = $1',
        [user.user_id, fresh, this.passwords.params],
      );
      this.log.info({ userId: user.user_id }, 'password rehashed with current cost model');
    }

    const { rows: membershipRows } = await this.db.query<{
      tenant_id: string;
      slug: string;
      name: string;
      plan: PlanId;
      role: 'owner' | 'admin' | 'member' | 'viewer';
    }>('SELECT * FROM app.tenants_for_user($1)', [user.user_id]);

    if (membershipRows.length === 0) {
      throw new AppError(
        'TENANT_MEMBERSHIP_REQUIRED',
        'This account has no workspace yet — create one with POST /v1/tenants',
        403,
      );
    }

    const picked = input.tenantSlug
      ? membershipRows.find((m) => m.slug === input.tenantSlug?.toLowerCase())
      : membershipRows.length === 1
        ? membershipRows[0]
        : undefined;

    if (!picked) {
      if (input.tenantSlug) {
        // Explicit slug that this user may not use: same answer as "wrong
        // password", so login cannot be used to discover workspace membership.
        throw unauthenticated('Invalid email or password');
      }
      return {
        needsTenantChoice: {
          candidates: membershipRows.map((m) => ({
            id: m.tenant_id,
            slug: m.slug,
            name: m.name,
            role: m.role,
          })),
        },
      };
    }

    const tenant = await this.loadTenantById(picked.tenant_id);
    const tokens = await this.issueSession({
      userId: user.user_id,
      email: user.email,
      tenant,
      role: picked.role,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return { tokens };
  }

  async refresh(input: {
    refreshToken: string;
    ip?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<{ tokens: SessionTokens }> {
    const presented = digestToken(input.refreshToken);
    const issued = randomToken(32);
    const next = digestToken(issued);

    const { rows } = await this.db.query<{
      result: 'ok' | 'reused' | 'expired' | 'unknown' | 'revoked';
      user_id: string | null;
      tenant_id: string | null;
      role: MembershipRow['role'] | null;
      session_id: string | null;
    }>(
      `SELECT o_result AS result,
              o_user_id AS user_id,
              o_tenant_id AS tenant_id,
              o_role AS role,
              o_session_id AS session_id
         FROM app.session_rotate($1,$2,$3::inet,$4,$5)`,
      [
        presented,
        next,
        input.ip ?? null,
        input.userAgent ?? null,
        this.cfg.env.REFRESH_TOKEN_TTL_DAYS,
      ],
    );

    const row = rows[0];
    if (!row || row.result === 'unknown') {
      throw unauthenticated('Refresh token is not recognised');
    }
    if (row.result === 'reused') {
      // Reuse of a spent token means the chain leaked: every session in the
      // family is already gone. Surface it distinctly so the client can force a
      // re-login *and* so the auth_events counter is alertable.
      throw new AppError(
        'REFRESH_REUSE_DETECTED',
        'This session was ended because its refresh token was replayed. Sign in again.',
        401,
      );
    }
    if (row.result !== 'ok' || !row.user_id || !row.tenant_id || !row.role || !row.session_id) {
      throw unauthenticated(row.result === 'expired' ? 'Session expired' : 'Session revoked');
    }

    const tenant = await this.loadTenantById(row.tenant_id);
    const { accessToken, expiresInSeconds } = await this.tokens.sign({
      userId: row.user_id,
      sessionId: row.session_id,
      email: '',
      tenantId: tenant.id,
      role: row.role,
    });

    return {
      tokens: {
        accessToken,
        refreshToken: issued,
        tokenType: 'Bearer',
        expiresIn: expiresInSeconds,
        tenant: { id: tenant.id, slug: tenant.slug, plan: tenant.plan, role: row.role },
      },
    };
  }

  async logout(input: {
    refreshToken?: string | undefined;
    allDevices: boolean;
    userId?: string;
    tenantId?: string;
  }): Promise<{ revoked: number }> {
    if (input.allDevices && input.userId && input.tenantId) {
      const { rows } = await this.db.query<{ n: string }>(
        'SELECT app.session_revoke_all($1,$2) AS n',
        [input.userId, input.tenantId],
      );
      return { revoked: Number(rows[0]?.n ?? 0) };
    }
    if (!input.refreshToken) {
      throw new AppError(
        'BAD_REQUEST',
        'Provide a refreshToken (or allDevices=true) to log out',
        400,
      );
    }
    const { rows } = await this.db.query<{ n: string }>('SELECT app.session_revoke($1) AS n', [
      digestToken(input.refreshToken),
    ]);
    return { revoked: Number(rows[0]?.n ?? 0) };
  }

  async sessions(userId: string, tenantId: string, currentSessionId: string) {
    const { rows } = await this.db.query<{
      id: string;
      created_at: Date;
      user_agent: string | null;
      ip: string | null;
      current: boolean;
    }>(
      'SELECT o_id AS id, o_created_at AS created_at, o_user_agent AS user_agent, o_ip AS ip, o_current AS current FROM app.sessions_for($1,$2,$3)',
      [userId, tenantId, currentSessionId],
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at.toISOString(),
      userAgent: r.user_agent,
      ip: r.ip,
      current: r.current,
    }));
  }

  private async issueSession(input: {
    userId: string;
    email: string;
    tenant: TenantRow;
    role: 'owner' | 'admin' | 'member' | 'viewer';
    ip?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<SessionTokens> {
    const refreshToken = randomToken(32);
    const { rows } = await this.db.query<{ session_id: string }>(
      // The OUT columns are o_-prefixed in SQL (plpgsql would otherwise confuse a
      // variable named `expires_at` with the column of the same name); the API
      // aliases them back at the boundary so the TypeScript shape stays readable.
      'SELECT o_session_id AS session_id FROM app.session_login($1,$2,$3,$4::inet,$5,$6)',
      [
        input.userId,
        input.tenant.id,
        digestToken(refreshToken),
        input.ip ?? null,
        input.userAgent ?? null,
        this.cfg.env.REFRESH_TOKEN_TTL_DAYS,
      ],
    );
    const sessionId = rows[0]!.session_id;

    const { accessToken, expiresInSeconds } = await this.tokens.sign({
      userId: input.userId,
      sessionId,
      email: input.email,
      tenantId: input.tenant.id,
      role: input.role,
    });

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: expiresInSeconds,
      tenant: {
        id: input.tenant.id,
        slug: input.tenant.slug,
        plan: input.tenant.plan,
        role: input.role,
      },
    };
  }

  async loadTenantById(id: string): Promise<TenantRow> {
    const { rows } = await this.db.query<{
      tenant_id: string;
      slug: string;
      name: string;
      plan: PlanId;
      status: 'active' | 'suspended' | 'cancelled';
      retention_days: number;
    }>('SELECT * FROM app.tenant_by_id($1)', [id]);
    const found = rows[0];
    if (!found) {
      throw tenantNotFound();
    }
    const tenant: TenantRow = { ...found, id: found.tenant_id };
    if (tenant.status !== 'active') {
      throw new AppError('FORBIDDEN', `Workspace "${tenant.slug}" is ${tenant.status}`, 403);
    }
    return tenant;
  }

  async membership(userId: string, tenantId: string): Promise<MembershipRow> {
    const { rows } = await this.db.query<MembershipRow>(
      'SELECT * FROM app.membership_role($1,$2)',
      [userId, tenantId],
    );
    const m = rows[0];
    if (!m || m.status !== 'active') {
      throw new AppError(
        'TENANT_MEMBERSHIP_REQUIRED',
        'You are not an active member of this workspace',
        403,
      );
    }
    return m;
  }

  touchPresence(userId: string, tenantId: string): Promise<unknown> {
    return this.db
      .query('SELECT app.touch_membership($1,$2)', [userId, tenantId])
      .catch((err: unknown) => this.log.warn({ err: String(err) }, 'presence update failed'));
  }
}

function friendlyConflict(message: string): string {
  if (/slug/i.test(message)) {
    return 'That workspace URL is already taken';
  }
  if (/email/i.test(message)) {
    return 'That email address is already registered';
  }
  return 'Resource already exists';
}

/** Hash of a value nobody can log in with; keeps the unknown-email path slow. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2VudGluZWw$M2p6d0hKcGd6Q0d6SjVoT3lFSjVRS0dYeXFKTXJ5VjNoODFGeS9KN1FmYw';

function uuid(): string {
  return crypto.randomUUID();
}
