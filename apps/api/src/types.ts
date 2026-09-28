import type { PlanLimits, Role } from '@saas/shared';
import type { PasswordService } from './modules/auth/passwords.js';
import type { UsageSnapshot } from './services/usage.js';
import type { Database } from '@saas/db';
import type { Actor, PlanId, RateLimiterBackend } from '@saas/shared';
import type { CacheStore } from './cache/store.js';
import type { RedisHandles } from './plugins/redis.js';
import type { AppMetrics, ReadinessReport } from './plugins/metrics.js';
import type { QueueProducer } from './queue/producer.js';
import type { IdempotencyService } from './lib/idempotency.js';
import type { AppConfig } from './config/index.js';
import type { TokenIssuer } from './modules/auth/tokens.js';
import type { MembershipPort } from './services/membership.js';
import type { AuthService } from './modules/auth/service.js';
import type { TenantService } from './modules/tenants/service.js';
import type { ProjectService } from './modules/projects/service.js';
import type { UserService } from './modules/users/service.js';

/** The authenticated caller, as services need it: who they are and what they may
 *  do *inside this tenant*. Passing the role alongside the id is what lets
 *  `withTenant` set `app.tenant_role`, which the RLS policies themselves read —
 *  a placeholder role here would silently turn every write into a 403. */
export interface Requester {
  userId: string;
  role: Role;
}

export interface ResolvedTenant {
  id: string;
  slug: string;
  name: string;
  plan: PlanId;
  status: 'active' | 'suspended' | 'cancelled';
  /** How the tenant was identified — surfaced in logs and the debug header. */
  resolvedVia: 'header' | 'subdomain' | 'token';
  /** Rate-limit + cache TTL inputs, resolved once per request. */
  planLimits: PlanLimits;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** ms since request start (set by the metrics hook). */
    auditStartMs?: number;
    /** Correlation id: echoed in `x-request-id` and every log line. */
    requestId: string;
    tenant?: ResolvedTenant;
    auth?: Actor;
    routeClass?: 'read' | 'write' | 'auth' | 'bulk';
    /** Tokens to charge this request to the bucket (bulk endpoints charge >1). */
    rateLimitCost?: number;
    /** Set when a request was allowed only because the limiter degraded. */
    rateLimitDegraded?: boolean;
    idempotencyKey?: string;
    /** True only when *this* request owns the key (it reserved it). The reply
     *  is recorded for replay only in that case; a replayed or conflicting one
     *  must never be written back over the key. */
    idempotencyReserved?: boolean;
    /** Snapshot of an idempotent replay, short-circuiting the handler. */
    idempotentReplay?: { status: number; body: unknown };
    /** Serialized response body, captured in onSend for idempotent replay. */
    idempotencyPayload?: string;
  }

  interface FastifyContextConfig {
    /** Auth requirement per route; 'none' is only for auth/health endpoints. */
    auth?: 'required' | 'optional' | 'none';
    /** Minimum role inside the tenant (implies auth required). */
    role?: 'owner' | 'admin' | 'member' | 'viewer';
    /** Force a rate-limit route class instead of inferring from the method. */
    routeClass?: 'read' | 'write' | 'auth' | 'bulk';
    /** Skip tenant resolution (platform-level endpoints). */
    publicTenantless?: boolean;
    /**
     * The route is authorized by *ownership*, not by role rank: the handler
     * filters on `user_id = app.current_user_id()` (caller profile, sessions,
     * the workspace list for this user). Declared explicitly so "no role" is a
     * statement about the authorization model rather than an omission — the
     * route-contract test rejects a route that has neither `role` nor this.
     */
    selfScoped?: boolean;
    /** Charge N tokens instead of 1 (expensive endpoints). */
    rateLimitCost?: number;
    /** Opt a GET route out of the cache (e.g. /readyz-style probes). */
    noCache?: boolean;
    /**
     * Idempotency-Key handling: 'required' rejects a POST without the header,
     * 'optional' honours it when present. Bulk/expensive POSTs use 'required'.
     */
    idempotency?: 'required' | 'optional';
    /** Human-readable operation id for OpenAPI + audit. */
    operationId?: string;
    summary?: string;
  }

  interface FastifyInstance {
    cfg: AppConfig;
    db: Database;
    redisHandles: RedisHandles;
    cache: CacheStore;
    limiter: RateLimiterBackend;
    /** Live backend after degradation; `degraded` flips when Redis is lost. */
    limiterState: { degraded: boolean; sinceMs: number | null };
    metrics: AppMetrics;
    producer: QueueProducer;
    idempotency: IdempotencyService;
    tokens: TokenIssuer;
    membership: MembershipPort;
    auth: AuthService;
    tenants: TenantService;
    projects: ProjectService;
    users: UserService;
    /** `RATE_LIMIT_ENABLED` as a resolved boolean (checked on every request). */
    limiterConfig: { enabled: boolean };
    passwords: PasswordService;
    /** Per-pod usage snapshot for `GET /v1/users/me/usage` (see services/usage.ts). */
    usageSummary(tenant: ResolvedTenant, days: number): Promise<UsageSnapshot>;
    readinessProbe?: () => Promise<ReadinessReport>;
  }
}

export {};
