import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/index.js';
import { createPasswordService } from '../modules/auth/passwords.js';
import { createTokenIssuer } from '../modules/auth/tokens.js';
import { AuthService } from '../modules/auth/service.js';
import { TenantService } from '../modules/tenants/service.js';
import { UserService } from '../modules/users/service.js';
import { ProjectService } from '../modules/projects/service.js';
import { CachedMembershipService } from '../services/membership.js';
import { IdempotencyService } from '../lib/idempotency.js';
import { usageSummary } from '../services/usage.js';
import type { ResolvedTenant } from '../types.js';
import { QueueProducer } from '../queue/producer.js';

/**
 * Service wiring, in one place, with the dependency graph visible from the top:
 *
 *   passwords ─┐
 *   tokens ────┼─► AuthService ─┐
 *   producer ──┘               ├─► routes
 *   db + cache ─► TenantService│
 *              └─► UserService ┘
 *              └─► ProjectService
 *
 * Decorations (rather than module-level singletons) exist so tests can build an
 * app over a *fresh* database with one call, and so nothing can accidentally
 * share a pool or a Redis client between two app instances in the same process.
 * `app.passwords` and `app.tokens` are exposed because the auth hook and the
 * password route both need them — that is the only reason they are public.
 */
export async function registerServices(
  app: FastifyInstance,
  cfg: AppConfig,
): Promise<{ producer: QueueProducer }> {
  const passwords = createPasswordService(app.log);
  const tokens = createTokenIssuer({
    secret: cfg.env.JWT_SECRET,
    issuer: cfg.env.JWT_ISSUER,
    audience: cfg.env.JWT_AUDIENCE,
    accessTtlSec: cfg.env.ACCESS_TOKEN_TTL,
    keyId: cfg.env.JWT_KEY_ID,
  });

  const cache = app.cache;
  const producer = new QueueProducer(cfg, app.db, app.log as never);
  const projects = new ProjectService(app.db, cache, cfg);
  const tenants = new TenantService(app.db, cache);
  const users = new UserService(app.db, cache, producer);

  app.decorate('cfg', cfg);
  app.decorate('passwords', passwords);
  app.decorate('tokens', tokens);
  app.decorate('membership', new CachedMembershipService(app));
  app.decorate('idempotency', new IdempotencyService(app));
  app.decorate('producer', producer);
  app.decorate('projects', projects);
  app.decorate('tenants', tenants);
  app.decorate('users', users);
  app.decorate('usageSummary', (tenant: ResolvedTenant, days: number) =>
    usageSummary(app, tenant, days),
  );
  app.decorate('auth', new AuthService(app.db, passwords, tokens, cfg, producer, app.log));

  await producer.start();
  app.addHook('onClose', async () => {
    await producer.close();
  });

  return { producer };
}
