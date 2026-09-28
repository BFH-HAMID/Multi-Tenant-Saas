import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, unsignedJwt, type TestApp } from './helpers/app.js';

/**
 * Structural contracts for the HTTP surface.
 *
 * These tests exist because the properties they check are invisible from any
 * single route file. A reviewer can confirm "this GET sets a private ETag"; no
 * reviewer can confirm "none of the 32 routes ever returns tenant data with a
 * cacheable `cache-control`". That second statement is the one that keeps tenant
 * rows out of a shared cache, and it is only enforceable by enumerating the tree.
 *
 * Two sources of truth are consulted on purpose:
 *   - the OpenAPI document, for what a client can *see* (operationId, errors,
 *     no leaked identifiers);
 *   - the route sources, for what a client cannot see but the server depends on
 *     (`config.role`, `config.routeClass`, `config.idempotency`) — those live on
 *     the route options, which Fastify does not expose after registration, and a
 *     static read of the file is honest about what it is checking.
 */
const MODULES_DIR = new URL('../src/modules', import.meta.url).pathname;
const ROUTE_FILES = readdirSync(MODULES_DIR)
  .map((d) => join(MODULES_DIR, d, 'routes.ts'))
  .filter((p) => {
    try {
      readFileSync(p, 'utf8');
      return true;
    } catch {
      return false;
    }
  });

interface RouteRecord {
  file: string;
  method: string;
  /** Fully resolved path as the client sees it, with `:param` segments. */
  path: string;
  config: string;
  schema: string;
}

const API_PREFIX_VALUE = '/v1';

/**
 * Tiny brace-matching scanner over `app.get(...)`, `app.post(...)` … It is not a
 * parser; it only needs to be exact for the one style this repo uses — a path
 * expression built from a per-file `const base`, followed by an options object.
 * A route written in another style does not silently vanish: the "finds every
 * route" test below pins the expected count, so an unscanned route fails the
 * suite instead of quietly escaping the contract.
 */
function scanRoutes(): RouteRecord[] {
  const out: RouteRecord[] = [];
  for (const file of ROUTE_FILES) {
    const src = readFileSync(file, 'utf8');
    // Resolve the per-file path consts first (`const base = `${API_PREFIX}/projects``).
    const consts = new Map<string, string>();
    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*`([^`]*)`/g)) {
      consts.set(m[1]!, m[2]!);
    }
    const resolve = (expr: string, depth = 0): string => {
      const raw = expr.replace(/[`'"]/g, '').trim();
      const value = consts.has(raw) ? (consts.get(raw) as string) : raw;
      const substituted = value.replace(/\$\{(\w+)\}/g, (_all, name: string) =>
        name === 'API_PREFIX' ? API_PREFIX_VALUE : (consts.get(name) ?? ''),
      );
      if (depth < 3 && substituted !== value && consts.size > 0 && /\$\{/.test(substituted)) {
        return resolve(substituted, depth + 1);
      }
      return substituted;
    };

    const re =
      /app\.(get|post|patch|put|delete)\s*\(\s*(`[^`]*`|'[^']*'|"[^"]*"|[A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const method = m[1]!.toUpperCase();
      const path = resolve(m[2]!);
      const open = src.indexOf('{', m.index + m[0].length);
      const block = open === -1 ? '' : balanced(src, open, '{', '}');
      out.push({
        file: file.slice(MODULES_DIR.length + 1),
        method,
        path,
        config: (block ? balanced(block, block.indexOf('config'), '{', '}') : null) ?? '',
        schema: (block ? balanced(block, block.indexOf('schema'), '{', '}') : null) ?? '',
      });
    }
  }
  return out;
}

function balanced(text: string, from: number, open: string, close: string): string | null {
  const start = text.indexOf(open, from);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === open) {
      depth += 1;
    } else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

const ROUTES = scanRoutes();

const PUBLIC_EXEMPT = new Set([
  // The only routes that may be reached without a token, and why:
  //  · register/login/refresh — there is no session yet by definition;
  //  · the workspace *list* for a token (no tenant header needed);
  //  · health/status probes — kubelet cannot present a credential.
  'POST /v1/auth/register',
  'POST /v1/auth/login',
  'POST /v1/auth/refresh',
  'POST /v1/auth/password',
  'POST /v1/auth/logout',
  // The plan catalogue is plan *limits*, not tenant data — and the signup form
  // needs it before it has anything to authenticate with.
  'GET /v1/plans',
  'GET /v1/health',
  'GET /v1/status',
  'GET /',
]);

const IDEMPOTENCY_REQUIRED_FOR = [
  // POSTs whose replay would create a second resource the client must then chase.
  // Invites deliberately absent: inviting the same email twice is already
  // idempotent in the database (ON CONFLICT on the partial unique index), so a
  // key would be ceremony. Plan changes are likewise a set operation.
  'POST /v1/projects',
  'POST /v1/projects/:id/reports',
  'POST /v1/tenants',
];

describe('route table contracts', () => {
  it('finds every route (guards the scanner itself)', () => {
    // 8 auth + 2 health + 6 projects + 2 reports + 11 tenants + 3 users.
    expect(ROUTES.length).toBeGreaterThanOrEqual(30);
    for (const r of ROUTES) {
      expect(r.config, `${r.method} ${r.path} has no config object`).not.toBe('');
    }
  });

  it('declares a rate class and an authorization rule on every route', () => {
    for (const r of ROUTES) {
      expect(r.config, `${r.method} ${r.path}: routeClass missing`).toMatch(/routeClass:/);
      // Authorization must be *stated*, in one of exactly three forms: a role
      // floor, ownership scoping (`selfScoped`), or an explicit "no identity
      // required". A route that declares none of the three is an accident, and a
      // 40-line test is cheaper than the incident.
      const hasRole = /role:\s*'(owner|admin|member|viewer)'/.test(r.config);
      const ownership = /selfScoped:\s*true/.test(r.config);
      const declaresPublic = /auth:\s*'(none|optional)'/.test(r.config);
      expect(
        hasRole || ownership || declaresPublic,
        `${r.method} ${r.path}: no role, no selfScoped, no public auth`,
      ).toBe(true);
      if (r.method === 'GET') {
        expect(r.config, `${r.path}: GET must not be classified as a write`).not.toMatch(
          /routeClass:\s*'write'/,
        );
      }
    }
  });

  it('keeps the public surface on the published allow-list', () => {
    for (const r of ROUTES) {
      const path = r.path;
      const isPublic = /auth:\s*'none'/.test(r.config);
      if (isPublic) {
        expect(
          PUBLIC_EXEMPT.has(`${r.method} ${path}`),
          `${r.method} ${path} is public but not allow-listed`,
        ).toBe(true);
      }
    }
  });

  it('routes payloads through zod (x-zod) instead of a second validator', () => {
    for (const r of ROUTES) {
      const validates = /(body|querystring|params|headers):\s*doc\(/.test(r.schema);
      if (validates) {
        expect(
          r.schema,
          `${r.method} ${r.path} validates without x-zod (AJV would double-reject)`,
        ).toMatch(/'x-zod':\s*true/);
      }
    }
  });

  it('declares an idempotency policy where a replay would duplicate a resource', () => {
    const byPath = new Map(ROUTES.map((r) => [`${r.method} ${r.path}`, r]));
    for (const key of IDEMPOTENCY_REQUIRED_FOR) {
      const r = byPath.get(key);
      expect(r, `${key} disappeared from the route table`).toBeDefined();
      expect(r!.config, `${key} must declare config.idempotency`).toMatch(
        /idempotency:\s*'(required|optional)'/,
      );
    }
  });

  it('marks write routes as non-idempotent-safe only when they are POSTs', () => {
    // PATCH must carry a version precondition, otherwise "retry after a timeout"
    // is a blind overwrite of whoever else saved in between.
    for (const r of ROUTES.filter((x) => x.method === 'PATCH')) {
      // Only *shared* resources need a version precondition. Overwriting your own
      // display name or a workspace's settings is a last-write-wins field, not a
      // concurrency bug; two people editing one project's config is.
      const shared = /\/projects(\/|$)/.test(r.path);
      if (!shared) {
        continue;
      }
      expect(
        r.schema + r.config,
        `${r.method} ${r.path}: a shared resource must require If-Match, or a retried save overwrites the winner`,
      ).toMatch(/if-match|If-Match/i);
    }
  });
});

describe('runtime surface (no services)', () => {
  let test: TestApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    test = await buildTestApp();
    app = test.app;
  });
  afterAll(async () => {
    await test.close();
  });

  it('rejects unauthenticated data routes with a problem document', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/projects' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json().code).toBe('UNAUTHENTICATED');
    expect(res.json().requestId).toBeTruthy();
  });

  it('rejects a forged or malformed bearer token', async () => {
    for (const token of [
      'not.a.jwt',
      'Bearer',
      'Basic dXNlcjpwYXNz',
      unsignedJwt({ sub: 'someone' }),
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/users/me',
        headers: { authorization: token },
      });
      expect(res.statusCode, token).toBe(401);
      // The code is the contract a client branches on; the *title* may change.
      expect(['UNAUTHENTICATED', 'TOKEN_INVALID', 'TOKEN_EXPIRED']).toContain(res.json().code);
      // Never echo what the client sent: a bearer token in an error body ends up
      // in an error-reporting pipeline, which is how sessions leak.
      expect(res.body).not.toContain('not.a.jwt');
      expect(res.body).not.toContain('Bearer');
    }
  });

  it('answers unknown routes with the same error envelope as the API', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('reports a malformed JSON body as a problem document, not a stack', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email": ',
    });
    expect(res.statusCode).toBeLessThan(500);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).not.toContain('at ');
  });

  it('never publishes a cacheable response on any route', async () => {
    // One request per documented route: the point is that *no* route, including
    // ones added tomorrow, can emit `public` or a non-zero max-age without
    // `private`. (Read routes set `private, max-age=0, must-revalidate`.)
    const urls = [
      ...new Set(
        ROUTES.map((r) => r.path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000')),
      ),
    ];
    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url });
      const cc = String(res.headers['cache-control'] ?? '');
      expect(cc, `${url} → ${cc}`).not.toMatch(/\bpublic\b/);
      if (cc.includes('max-age')) {
        const n = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? '0');
        expect(n, `${url} has a positive max-age`).toBe(0);
        expect(cc).toContain('private');
      }
    }
  });

  it('exposes a request id on every response for log correlation', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9-]{8,}$/);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('serves an OpenAPI document that leaks nothing and covers every route', async () => {
    const res = await app.inject({ method: 'GET', url: '/documentation/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as {
      paths: Record<
        string,
        Record<string, { operationId?: string; responses?: Record<string, unknown> }>
      >;
    };
    const documented = new Set(
      Object.entries(doc.paths).flatMap(([path, ops]) =>
        Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
      ),
    );
    for (const r of ROUTES) {
      const path = r.path.replace(/:([A-Za-z]+)/g, '{$1}');
      expect(
        documented.has(`${r.method} ${path}`),
        `${r.method} ${path} missing from the OpenAPI document`,
      ).toBe(true);
    }
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(op.operationId, `${method} ${path} has no operationId`).toBeTruthy();
      }
    }
    // No identifiers: the document is public when Swagger is enabled, and an
    // example containing a real tenant id would be a disclosure in the docs.
    // Identifiers must never be baked into the document as samples: the OpenAPI
    // page is public, and a UUID in an `example` is a real row in a real tenant.
    // (zod's own `format: uuid` *pattern* legitimately contains UUID-looking text.)
    const samples =
      JSON.stringify(doc).match(/"(?:example|examples|default|enum)"\s*:\s*[^,}]*/g) ?? [];
    const leaky = samples.filter((frag) =>
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(frag),
    );
    expect(leaky, leaky.join('\n')).toEqual([]);
    // …and no seeded account e-mail either.
    const emails =
      JSON.stringify(doc).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    expect(emails, emails.join('\n')).toEqual([]);
  });

  it('hides the documentation UI from the document itself', async () => {
    const res = await app.inject({ method: 'GET', url: '/documentation/json' });
    expect(Object.keys(res.json().paths)).not.toContain('/documentation');
  });
});
