import { describe, expect, it } from 'vitest';
import { extractTenantHint, isSlug, isUuid, normalizeSlug, tenantFromHost } from '../src/tenant.js';
import {
  createProjectSchema,
  generateReportSchema,
  listProjectsQuery,
  loginSchema,
  passwordSchema,
  registerSchema,
  updateTenantSchema,
} from '../src/schemas/index.js';
import { AppError, notFound, rateLimited, validationFailed } from '../src/errors.js';
import { hasRole } from '../src/types.js';
import { digestToken, hmac, uuidv7 } from '../src/security.js';
import { constantTimeEqual } from '../src/security.js';
import { OUTBOX_TOPICS, parsePayload, queueForJob, JOBS } from '../src/queues.js';

const BASE = { baseDomains: ['api.saas.dev', 'localhost'], allowLocalhostLabel: true };
const TENANT = '4f1c3b2a-5d6e-4a7b-8c9d-0e1f2a3b4c5d';

describe('tenant resolution', () => {
  it('prefers an explicit id header over slug and token', () => {
    const hint = extractTenantHint(
      {
        headerTenantId: TENANT.toUpperCase(),
        headerSlug: 'acme',
        host: 'globex.api.saas.dev',
        tokenTenantId: '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
      },
      BASE,
    );
    expect(hint).toEqual({ kind: 'id', value: TENANT, source: 'header' });
  });

  it('uses the subdomain when no header is present', () => {
    expect(extractTenantHint({ host: 'acme.api.saas.dev' }, BASE)).toEqual({
      kind: 'slug',
      value: 'acme',
      source: 'subdomain',
    });
    expect(extractTenantHint({ host: 'ACME.api.saas.dev:3000' }, BASE)).toEqual({
      kind: 'slug',
      value: 'acme',
      source: 'subdomain',
    });
  });

  it('falls back to the token claim', () => {
    expect(extractTenantHint({ host: 'api.saas.dev', tokenTenantId: TENANT }, BASE)).toEqual({
      kind: 'id',
      value: TENANT,
      source: 'token',
    });
  });

  it('returns none for apex hosts and junk labels', () => {
    expect(extractTenantHint({ host: 'api.saas.dev' }, BASE)).toEqual({ kind: 'none' });
    expect(tenantFromHost('evil-api.saas.dev.attacker.com', BASE)).toBeNull();
    expect(tenantFromHost('a.b.api.saas.dev', BASE)).toBeNull();
    // Hostnames are case-insensitive per DNS; the label is lowercased before the
    // slug check, so `ACME.api.saas.dev` is a legitimate tenant hint.
    expect(tenantFromHost('UPPER.api.saas.dev', BASE)).toBe('upper');
  });

  it('rejects malformed ids and slugs so they never reach SQL', () => {
    expect(isUuid(`${TENANT}xyz`)).toBe(false);
    expect(isUuid('acme')).toBe(false);
    expect(isSlug('ok-slug-1')).toBe(true);
    expect(isSlug('-lead')).toBe(false);
    expect(isSlug('a')).toBe(false); // min length 2
    expect(isSlug('UNSAFE')).toBe(false);
    expect(normalizeSlug('  Acme, Inc.! ')).toBe('acme-inc');
  });
});

describe('DTO schemas', () => {
  it('register normalises and defaults', () => {
    const parsed = registerSchema.parse({
      tenant: { name: 'Acme Rockets', slug: 'acme' },
      user: { email: '  Ada@Example.COM ', password: 'correct-horse-battery' },
    });
    expect(parsed.tenant.plan).toBe('free');
    expect(parsed.user.email).toBe('ada@example.com');
  });

  it('register rejects a bad slug and a weak password', () => {
    expect(() =>
      registerSchema.parse({
        tenant: { name: 'Acme', slug: 'Acme R' },
        user: { email: 'a@b.co', password: 'correct-horse-battery' },
      }),
    ).toThrow();
    expect(() => passwordSchema.parse('short1!')).toThrow();
    expect(() => passwordSchema.parse('aaaaaaaaaaaaaaaaa')).toThrow(); // all-lowercase
    expect(passwordSchema.parse('Mix1d-length-passphrase')).toBe('Mix1d-length-passphrase');
  });

  it('login requires an email-shaped identifier and a real password', () => {
    expect(
      loginSchema.safeParse({ email: 'nope', password: 'correct-horse-battery' }).success,
    ).toBe(false);
    expect(
      loginSchema.safeParse({ email: 'a@b.co', password: 'correct-horse-battery' }).success,
    ).toBe(true);
    // A 12-char all-lowercase string is not "strong" by our definition, and the
    // login DTO shares the registration policy so clients get one answer.
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'aaaaaaaaaaaa' }).success).toBe(
      false,
    );
  });

  it('list query clamps limit and defaults sort', () => {
    const q = listProjectsQuery.parse({ limit: '900' });
    expect(q.limit).toBe(100); // clamped, not rejected: pagination is forgiving
    expect(q.sort).toBe('createdAt');
    expect(q.order).toBe('desc');
    expect(q.status).toBe('active');
    expect(listProjectsQuery.parse({ limit: 0 }).limit).toBe(1);
    expect(listProjectsQuery.parse({}).limit).toBe(25);
    expect(() => listProjectsQuery.parse({ limit: 'abc' })).toThrow();
    expect(() => listProjectsQuery.parse({ limit: 1.5 })).toThrow(); // must be an integer
  });

  it('create project rejects unknown keys (strict) and empty names', () => {
    expect(createProjectSchema.safeParse({ name: '', slug: 'x' }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: 'ok', evil: true }).success).toBe(false);
    const ok = createProjectSchema.parse({ name: 'Q3 launch', tags: ['launch'] });
    expect(ok.slug).toBeUndefined();
  });

  it('update tenant refuses an empty patch', () => {
    expect(updateTenantSchema.safeParse({}).success).toBe(false);
    expect(updateTenantSchema.safeParse({ name: 'New' }).success).toBe(true);
    expect(updateTenantSchema.safeParse({ settings: { timezone: 'UTC' } }).success).toBe(true);
  });

  it('report request defaults and idempotency key passthrough', () => {
    const r = generateReportSchema.parse({});
    expect(r.format).toBe('json');
    expect(r.includeArchived).toBe(false);
    const withKey = generateReportSchema.parse({ format: 'csv', idempotencyKey: 'abc-123-def' });
    expect(withKey.idempotencyKey).toBe('abc-123-def');
  });
});

describe('errors → problem+json', () => {
  it('exposes client-safe text for 4xx and hides it for 5xx', () => {
    const nf = notFound('Project');
    expect(nf.statusCode).toBe(404);
    expect(nf.toProblem()).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      detail: 'Project not found',
    });

    const hidden = new AppError('INTERNAL', 'connection to pg-primary-3 failed: FATAL', 500, {
      expose: false,
    });
    const problem = hidden.toProblem();
    expect(problem.detail).toBeUndefined();
    expect(problem.title).toBe('Internal server error');
    expect(JSON.stringify(problem)).not.toMatch(/pg-primary-3/);
  });

  it('429 carries Retry-After in seconds', () => {
    const e = rateLimited(2500);
    expect(e.headers?.['retry-after']).toBe('3');
  });

  it('validation failures surface per-field messages', () => {
    const e = validationFailed([{ path: 'body.name', message: 'too short' }]);
    expect(e.toProblem().errors).toEqual([{ path: 'body.name', message: 'too short' }]);
    expect(e.statusCode).toBe(422);
  });
});

describe('RBAC ordering', () => {
  it('higher ranks satisfy lower requirements', () => {
    expect(hasRole('owner', 'admin')).toBe(true);
    expect(hasRole('admin', 'owner')).toBe(false);
    expect(hasRole('member', 'viewer')).toBe(true);
    expect(hasRole(null, 'member')).toBe(false);
  });
});

describe('queue contracts', () => {
  it('maps every job name to a queue', () => {
    for (const job of Object.values(JOBS)) {
      expect(queueForJob(job)).toBe(OUTBOX_TOPICS[job]);
    }
  });

  it('rejects a payload missing its idempotency key', () => {
    expect(() =>
      parsePayload(JOBS.emailWelcome, {
        kind: JOBS.emailWelcome,
        tenantId: TENANT,
        tenantSlug: 'acme',
        userId: TENANT,
        email: 'a@b.co',
        displayName: null,
        requestedAt: new Date().toISOString(),
      }),
    ).toThrow(/idempotencyKey/);
  });

  it('accepts a well-formed report payload', () => {
    const p = parsePayload(JOBS.reportGenerate, {
      kind: JOBS.reportGenerate,
      tenantId: TENANT,
      requestedBy: TENANT,
      jobId: 'job-1234567890',
      idempotencyKey: 'idem-1234567890',
      options: { format: 'csv', includeArchived: false },
      requestedAt: new Date().toISOString(),
    });
    expect(p.kind).toBe(JOBS.reportGenerate);
  });
});

describe('security helpers', () => {
  it('token digests are stable, hex and 64 chars', () => {
    const d = digestToken('abc');
    expect(d).toBe(digestToken('abc'));
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d).not.toBe(digestToken('abd'));
  });

  it('constantTimeEqual handles length mismatch', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('hmac is url-safe base64 without padding', () => {
    expect(hmac('key', 'payload')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hmac('key', 'payload')).toBe(hmac('key', 'payload'));
  });

  it('uuidv7 embeds a decodable millisecond timestamp and version 7', () => {
    const t = 1_780_000_000_123;
    const id = uuidv7(t);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const hex = id.replace(/-/g, '');
    expect(parseInt(hex.slice(0, 12), 16)).toBe(t);
    expect(uuidv7(t + 5000).slice(0, 8)).toBe(id.slice(0, 8)); // same second bucket
  });
});
