import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIVE_PASSWORD,
  NO_DATABASE,
  openLiveTestApp,
  type LiveApp,
  type LiveSession,
} from './helpers/liveApp.js';

/**
 * Projects, against a real PostgreSQL.
 *
 * These are the behaviours the stub harness structurally cannot check: the row
 * is really filtered by RLS, the quota really rolls back, the ETag really changes
 * with the row version, and a replayed POST really is not executed twice.
 */

const live = {} as { app: LiveApp & { session: LiveSession } };
let other!: LiveSession;

beforeAll(async () => {
  live.app = await openLiveTestApp();
  // A second workspace, so "cross-tenant" means two live tenants rather than a
  // forged token.
  other = await live.app.enroll({ plan: 'pro' });
}, 120_000);

afterAll(async () => {
  await live.app?.close();
});

const skip = NO_DATABASE;

describe.skipIf(skip)('project lifecycle', () => {
  it('registers a workspace and lets its owner read it back', async () => {
    const { app, auth, session } = live.app;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenants/current',
      headers: auth(session),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: session.tenantId, slug: session.tenantSlug });
  });

  it('creates, lists with an ETag, and answers a conditional GET with 304', async () => {
    const { app, auth, session } = live.app;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: auth(session),
      payload: { name: 'Launch board', description: 'one project per line' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe(`/v1/projects/${created.json().id}`);
    // A fresh row is version 1 (the trigger that enforces quotas bumps on insert),
    // and `version` is what the etag of a single project encodes.
    expect(created.json()).toMatchObject({
      status: 'active',
      version: 1,
      tenantId: session.tenantId,
    });
    expect(created.headers.etag).toBe('W/"v1"');
    expect(created.headers['cache-control'] ?? '').not.toMatch(/max-age=[1-9]/);

    const list = await app.inject({ method: 'GET', url: '/v1/projects', headers: auth(session) });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.some((p: { id: string }) => p.id === created.json().id)).toBe(true);
    const etag = list.headers.etag as string;
    expect(etag).toMatch(/^W\/"[0-9a-z]+"$/);
    expect(String(list.headers['cache-control'])).toContain('private');

    const again = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: auth(session, { 'if-none-match': etag }),
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('refuses a blind update, then a stale one, then accepts the right version', async () => {
    const { app, auth, session } = live.app;
    const id = await createProject(app, auth, session, 'Concurrency');
    const fresh = await app.inject({
      method: 'GET',
      url: `/v1/projects/${id}`,
      headers: auth(session),
    });
    const etag = fresh.headers.etag as string;

    const blind = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${id}`,
      headers: auth(session),
      payload: { name: 'Silently overwritten' },
    });
    expect(blind.statusCode).toBe(428);
    expect(blind.json().code).toBe('PRECONDITION_REQUIRED');

    const garbage = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${id}`,
      headers: auth(session, { 'if-match': 'W/"not-the-current-version"' }),
      payload: { name: 'Not even a version' },
    });
    // An ETag we cannot interpret is answered before the row is even looked at:
    // guessing "they probably meant the current version" would be a silent
    // last-write-wins again.
    expect(garbage.statusCode).toBe(412);
    expect(garbage.json().code).toBe('PRECONDITION_FAILED');

    // The real lost update: write once, then replay the *previous* etag.
    const firstWrite = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${id}`,
      headers: auth(session, { 'if-match': etag }),
      payload: { name: 'Renamed properly' },
    });
    expect(firstWrite.statusCode).toBe(200);
    expect(firstWrite.json()).toMatchObject({ name: 'Renamed properly', version: 2 });
    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${id}`,
      headers: auth(session, { 'if-match': etag }),
      payload: { name: 'Lost update' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('CONFLICT');
    // The 409 must say what to re-read, otherwise clients retry blindly.
    expect(JSON.stringify(stale.json())).toContain('currentVersion');
    const untouched = await app.inject({
      method: 'GET',
      url: `/v1/projects/${id}`,
      headers: auth(session),
    });
    expect(untouched.json().name).toBe('Renamed properly');

    const good = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${id}`,
      headers: auth(session, { 'if-match': firstWrite.headers.etag as string }),
      payload: { description: 'second writer' },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toMatchObject({ version: 3 });
  });

  it('replays an idempotent POST without creating a second row', async () => {
    const { app, auth, session } = live.app;
    const key = `it-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const headers = auth(session, { 'idempotency-key': key });
    const first = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload: { name: 'Exactly once' },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload: { name: 'Exactly once' },
    });
    // Same identity, same answer — and the *same* project id is the proof that no
    // second insert happened.
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json().id).toBe(first.json().id);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/projects?limit=100',
      headers: auth(session),
    });
    const mine = (list.json().data as Array<{ name: string }>).filter(
      (p) => p.name === 'Exactly once',
    );
    expect(mine).toHaveLength(1);
  });

  it('rejects a second POST under the same key with a different body', async () => {
    const { app, auth, session } = live.app;
    const key = `it-conflict-${Date.now()}`;
    const headers = auth(session, { 'idempotency-key': key });
    await app.inject({ method: 'POST', url: '/v1/projects', headers, payload: { name: 'Body A' } });
    const conflicting = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload: { name: 'Body B' },
    });
    expect(conflicting.statusCode).toBe(409);
    // Distinct from a version conflict on purpose: the fix is "use a new key",
    // not "re-read the row".
    expect(conflicting.json().code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('deletes, and the row is gone rather than merely hidden', async () => {
    const { app, auth, session, db } = live.app;
    const id = await createProject(app, auth, session, 'Disposable');
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${id}`,
      headers: auth(session),
    });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe('');
    const gone = await app.inject({
      method: 'GET',
      url: `/v1/projects/${id}`,
      headers: auth(session),
    });
    expect(gone.statusCode).toBe(404);
    const raw = await db
      .withTenant({ tenantId: session.tenantId, userId: session.userId, role: 'owner' }, (tx) =>
        tx.query('SELECT 1 FROM projects WHERE id = $1', [id]),
      )
      .catch(() => null);
    expect(raw?.rowCount ?? 0).toBe(0);
  });
});

describe.skipIf(skip)('tenant isolation', () => {
  it('answers 404, not 403, for another tenant’s project id', async () => {
    const { app, auth, session } = live.app;
    const id = await createProject(app, auth, session, 'Private to acme');
    const peek = await app.inject({
      method: 'GET',
      url: `/v1/projects/${id}`,
      headers: auth(other),
    });
    // A 403 would confirm the id exists, which is itself a leak across tenants.
    expect(peek.statusCode).toBe(404);
    const mutate = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${id}`,
      // Well-formed on purpose: an unparseable precondition is answered with 412
      // before the row is read, which would hide the isolation assertion.
      headers: auth(other, { 'if-match': 'W/"v1"' }),
      payload: { name: 'hijacked' },
    });
    expect(mutate.statusCode).toBe(404);
  });

  it('refuses a foreign x-tenant-slug rather than silently switching workspace', async () => {
    const { app, auth, session } = live.app;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: auth(session, { 'x-tenant-slug': other.tenantSlug }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });

  it('filters at the database, not in the handler', async () => {
    const { app, auth, session, db } = live.app;
    await createProject(app, auth, session, 'Invisible to the other tenant');
    const asOther = await db.withTenant(
      { tenantId: other.tenantId, userId: other.userId, role: 'owner' },
      async (tx) => (await tx.query('SELECT id, name FROM projects')).rows,
    );
    expect(asOther.some((r: { name: string }) => r.name === 'Invisible to the other tenant')).toBe(
      false,
    );
    // …and a connection with no tenant pinned sees nothing at all, because the
    // policies are FORCED rather than merely present.
    const unscoped = await db
      .query<{ n: string }>('SELECT count(*)::text AS n FROM projects')
      .catch((err: unknown) => ({ rows: [{ n: `error:${String(err).slice(0, 40)}` }] }));
    expect(Number(unscoped.rows[0]?.n ?? -1)).toBe(0);
  });
});

describe.skipIf(skip)('plan quota', () => {
  it('stops the free plan at its limit and leaves no partial write behind', async () => {
    const { app, auth, count } = live.app;
    const free = await live.app.enroll({ plan: 'free' });
    const created: string[] = [];
    for (let i = 0; i < 10; i++) {
      created.push(await createProject(app, auth, free, `Quota project ${i}`));
    }
    expect(created).toHaveLength(10);
    const over = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: auth(free),
      payload: { name: 'Project 11' },
    });
    expect(over.statusCode).toBe(402);
    expect(over.json().code).toBe('QUOTA_EXCEEDED');
    expect(String(over.json().detail)).toMatch(/free|project/i);
    expect(await count(free, 'projects')).toBe(10);
  }, 60_000);
});

describe.skipIf(skip)('input validation and errors', () => {
  it('reports every offending field with a pointer, in problem+json', async () => {
    const { app, auth, session } = live.app;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: auth(session),
      payload: { name: '', slug: 'NOPE NOPE', extra: true },
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json() as {
      code: string;
      errors?: Array<{ path: string; message: string }>;
      requestId?: string;
    };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.requestId).toMatch(/[0-9a-f-]{8,}/);
    const paths = (body.errors ?? []).map((e) => e.path);
    expect(paths).toContain('name');
    expect(paths).toContain('slug');
    // A key the body is not allowed to have is reported against the object root
    // (that is where `.strict()` sees it), with the offending name in the message.
    const extra = (body.errors ?? []).find((e) => /extra/.test(e.message));
    expect(extra, JSON.stringify(body.errors)).toBeDefined();
  });

  it('rejects a malformed body with 400 problem+json, echoing nothing back', async () => {
    const { app, auth, session } = live.app;
    const secret = 'do-not-echo-me';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...auth(session), 'content-type': 'application/json' },
      payload: `{"name": ${secret}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toMatch(/BAD_REQUEST|INVALID_JSON/);
    expect(res.body).not.toContain(secret);
  });

  it('accepts the seeded password for an owner-created member login', async () => {
    // Sanity check on the credential path itself: a fresh registration can log in
    // again, which is what proves `register` and `login` hash identically.
    const { app, session } = live.app;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: session.email, password: LIVE_PASSWORD, tenantSlug: session.tenantSlug },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTypeOf('string');
    expect(res.json().tenant.role).toBe('owner');
  });
});

async function createProject(
  app: LiveApp['app'],
  auth: LiveApp['auth'],
  session: LiveSession,
  name: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: auth(session),
    payload: { name },
  });
  if (res.statusCode !== 201) {
    throw new Error(`create "${name}" failed (${res.statusCode}): ${res.body.slice(0, 300)}`);
  }
  return String((res.json() as { id: string }).id);
}
