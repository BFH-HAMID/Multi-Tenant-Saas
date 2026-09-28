import { AUTH_CLASS, planLimits } from '@saas/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIVE_PASSWORD,
  NO_DATABASE,
  openLiveTestApp,
  type LiveApp,
  type LiveSession,
} from './helpers/liveApp.js';

/**
 * Session lifecycle against the real `app.session_*` SQL.
 *
 * Rotation, reuse detection and "change the password, get logged out everywhere"
 * are all one atomic statement each — a read-then-write in the handler would be
 * race-able by two concurrent refreshes of the same token, which is exactly the
 * scenario an attacker who copied a refresh token creates. So the tests below
 * assert the *database's* answers, not a mock's.
 */

const live = {} as { app: LiveApp & { session: LiveSession } };

beforeAll(async () => {
  // Credential mechanics and throttling mechanics are separate contracts, and the
  // anonymous brake (5 auth attempts per IP) is a *per-IP* bucket: every inject()
  // in this file shares one address, so the limiter is off here and asserted on its
  // own below, against its own app instance.
  live.app = await openLiveTestApp({ RATE_LIMIT_ENABLED: 'false' });
}, 120_000);

afterAll(async () => {
  await live.app?.close();
});

interface Tokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
}

async function login(email: string, password: string, slug?: string): Promise<Tokens> {
  const res = await live.app.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password, ...(slug ? { tenantSlug: slug } : {}) },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed (${res.statusCode}): ${res.body.slice(0, 200)}`);
  }
  return res.json() as Tokens;
}

async function refresh(token: string) {
  return live.app.app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refreshToken: token },
  });
}

describe.skipIf(NO_DATABASE)('session rotation', () => {
  it('mints a pair whose tenant claim matches the workspace it was created in', async () => {
    const { session } = live.app;
    const t = await login(session.email, LIVE_PASSWORD, session.tenantSlug);
    const claims = JSON.parse(
      Buffer.from(t.accessToken.split('.')[1] ?? '', 'base64url').toString(),
    ) as {
      tid: string;
      role: string;
      sid?: string;
    };
    expect(claims.tid).toBe(session.tenantId);
    expect(claims.role).toBe('owner');
    expect(t.expiresIn).toBeGreaterThan(0);
    expect(t.tokenType).toBe('Bearer');

    const me = await live.app.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${t.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json() as {
      user: { email: string; displayName: string | null };
      role: string;
      sessionId: string;
      limits: { maxProjects: number };
    };
    expect(body.user.email).toBe(session.email);
    expect(body.role).toBe('owner');
    expect(body.sessionId).toBeTypeOf('string');
    // Plan geometry is delivered here so a client never has to infer limits from 402s.
    expect(body.limits.maxProjects).toBe(250);
  });

  it('rotates on refresh, and the superseded token is dead', async () => {
    const { session } = live.app;
    const first = await login(session.email, LIVE_PASSWORD, session.tenantSlug);
    const second = await refresh(first.refreshToken);
    expect(second.statusCode).toBe(200);
    const rotated = second.json() as Tokens;
    // Same string back would mean rotation is theatre.
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    expect(rotated.accessToken).toBeTypeOf('string');

    const replay = await refresh(first.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('REFRESH_REUSE_DETECTED');
  });

  it('revokes the whole family on reuse, so the stolen-token victim is logged out too', async () => {
    const { session } = live.app;
    const victim = await login(session.email, LIVE_PASSWORD, session.tenantSlug);
    const rotated = (await refresh(victim.refreshToken)).json() as Tokens;

    // Attacker replays the token they copied: that is the detection signal.
    const attacker = await refresh(victim.refreshToken);
    expect(attacker.statusCode).toBe(401);

    // The consequence that matters: the victim's *current* token must stop
    // working as well. A revocation that leaves the legitimate session running
    // means we detected a theft and then declined to act on it.
    const victimAfter = await refresh(rotated.refreshToken);
    expect(victimAfter.statusCode).toBe(401);
  });

  it('lists sessions and revokes one at a time on logout', async () => {
    const { app, session, auth } = live.app;
    const a = await login(session.email, LIVE_PASSWORD, session.tenantSlug);
    const b = await login(session.email, LIVE_PASSWORD, session.tenantSlug);
    expect(a.refreshToken).not.toBe(b.refreshToken);

    const sessions = await app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: auth({ ...session, accessToken: b.accessToken }),
    });
    expect(sessions.statusCode).toBe(200);
    const rows = (sessions.json() as { data: Array<{ current?: boolean }> }).data;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Exactly one row is flagged as the caller's own — the UI's "log out
    // everywhere else" button depends on distinguishing it.
    expect(rows.filter((r) => r.current === true)).toHaveLength(1);

    const out = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: auth({ ...session, accessToken: b.accessToken }),
      payload: { refreshToken: a.refreshToken },
    });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toMatchObject({ revoked: 1 });
    expect(out.headers['cache-control']).toContain('no-store');

    const dead = await refresh(a.refreshToken);
    expect(dead.statusCode).toBe(401);
    const still = await refresh(b.refreshToken);
    expect(still.statusCode).toBe(200);
  });

  it('allDevices leaves no session behind', async () => {
    const { app, session, auth } = live.app;
    const keep = await login(session.email, LIVE_PASSWORD, session.tenantSlug);
    const extra = await login(session.email, LIVE_PASSWORD, session.tenantSlug);

    const out = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: auth({ ...session, accessToken: extra.accessToken }),
      payload: { allDevices: true },
    });
    expect(out.statusCode).toBe(200);
    expect(Number(out.json().revoked)).toBeGreaterThanOrEqual(2);
    for (const token of [keep.refreshToken, extra.refreshToken]) {
      expect((await refresh(token)).statusCode).toBe(401);
    }
  });
});

describe.skipIf(NO_DATABASE)('anonymous brake', () => {
  it('throttles repeated credential attempts from one address before any tenant is known', async () => {
    const limited = await openLiveTestApp();
    try {
      // `?.` + the guard below: if the route class is ever renamed, this must fail
      // loudly rather than silently testing a capacity of zero.
      const capacity = planLimits('free').routes[AUTH_CLASS]?.capacity ?? 0;
      expect(capacity).toBeGreaterThan(0);
      let status = 0;
      let attempt = 0;
      for (; attempt < capacity * 3 && status !== 429; attempt++) {
        const res = await limited.app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: `nobody${attempt}@nowhere.test`, password: 'guessing-is-my-job-123' },
        });
        status = res.statusCode;
      }
      // The brake is the plan's declared bucket, read here rather than repeated
      // as a literal so the assertion cannot drift from the geometry the load
      // tests and the alerts use. It must bite at the capacity: a limiter that only
      // engages after ten times that is decoration.
      expect(status, `429 never arrived in ${attempt} attempts`).toBe(429);
      expect(attempt).toBeLessThanOrEqual(capacity);
      const res = await limited.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'nobody@nowhere.test', password: 'guessing-is-my-job-123' },
      });
      expect(res.headers['retry-after']).toMatch(/^\d+$/);
      expect(res.json().code).toBe('RATE_LIMITED');
      expect(Number(res.json().details?.retryAfterMs)).toBeGreaterThan(0);
      // …and the answer is the same for a *valid* account: the brake is about the
      // address, not about whether the credentials were close.
      const valid = await limited.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: limited.session.email, password: LIVE_PASSWORD },
      });
      expect(valid.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  }, 60_000);
});

describe.skipIf(NO_DATABASE)('credentials', () => {
  it('does not distinguish an unknown account from a wrong password', async () => {
    const { app, session } = live.app;
    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: session.email,
        password: 'definitely-not-it-1234',
        tenantSlug: session.tenantSlug,
      },
    });
    const nobody = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: `ghost-${Date.now()}@nowhere.test`, password: 'definitely-not-it-1234' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(nobody.statusCode).toBe(401);
    // Same code *and* same title: an enumeration oracle is a difference in shape.
    expect(nobody.json().code).toBe(wrong.json().code);
    expect(nobody.json().title).toBe(wrong.json().title);
  });

  it('rejects a token signed with another secret', async () => {
    const { app } = live.app;
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
      sub: '11111111-1111-4111-8111-111111111111',
      tid: '11111111-1111-4111-8111-111111111111',
      role: 'owner',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.${b64({ signature: 'not-from-our-secret' })}`;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).not.toBe('TENANT_MEMBERSHIP_REQUIRED');
  });

  it('changing the password kills every session, and only the right current password does', async () => {
    const { app, session, auth } = live.app;
    const before = await login(session.email, LIVE_PASSWORD, session.tenantSlug);

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: auth({ ...session, accessToken: before.accessToken }),
      payload: {
        currentPassword: 'wrong-but-long-enough-1',
        newPassword: 'Another-Valid-Pass-2026!',
      },
    });
    expect(denied.statusCode).toBe(400);
    // The refusal must not be a "did they have that password?" oracle: the account
    // stays usable with the real one.
    expect((await login(session.email, LIVE_PASSWORD, session.tenantSlug)).accessToken).toBeTypeOf(
      'string',
    );

    const next = await login(session.email, LIVE_PASSWORD, session.tenantSlug);
    const changed = await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: auth({ ...session, accessToken: next.accessToken }),
      payload: { currentPassword: LIVE_PASSWORD, newPassword: 'Rotated-Test-Pass-2026!' },
    });
    expect(changed.statusCode).toBe(204);

    // Old password gone, new one in, and every refresh token from before is dead —
    // the trigger on `users` revokes them, so "log out everywhere" is not a
    // separate call a client can forget to make.
    await expect(login(session.email, LIVE_PASSWORD, session.tenantSlug)).rejects.toThrow(/401/);
    const withNew = await login(session.email, 'Rotated-Test-Pass-2026!', session.tenantSlug);
    expect(withNew.accessToken).toBeTypeOf('string');
    expect((await refresh(before.refreshToken)).statusCode).toBe(401);
    expect((await refresh(next.refreshToken)).statusCode).toBe(401);

    // …and the session table agrees: nothing un-revoked is left for this user.
    const remaining = await app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${withNew.accessToken}` },
    });
    // The password change happened *before* this login, so exactly this session
    // is alive and no older one is.
    expect((remaining.json() as { data: unknown[] }).data).toHaveLength(1);

    // Restore for the rest of this file's run: the harness keeps a live tenant
    // account, and the next test in the file expects the standard password.
    await app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { authorization: `Bearer ${withNew.accessToken}` },
      payload: { currentPassword: 'Rotated-Test-Pass-2026!', newPassword: LIVE_PASSWORD },
    });
  }, 60_000);
});
