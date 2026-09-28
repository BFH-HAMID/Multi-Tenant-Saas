/**
 * Public surface of the API package, for tests and for a future monorepo
 * consumer (a worker that wants to mint a token, an integration test that wants
 * `buildApp()` over its own database).
 *
 * Nothing starts a server by importing this module — `server.ts` is the entry
 * point. That separation is what makes the e2e tests able to call `buildApp`
 * without double-binding ports.
 */
export { buildApp, type BuildOptions } from './app.js';
export { loadConfig, printableConfig, type AppConfig, type EnvConfig } from './config/index.js';
export { API_PREFIX } from './config/constants.js';
export { createTokenIssuer } from './modules/auth/tokens.js';
export { createPasswordService } from './modules/auth/passwords.js';
export { CacheStore } from './cache/store.js';
export { IdempotencyService } from './lib/idempotency.js';
export { QueueProducer } from './queue/producer.js';
export { etagFor, encodeCursor, decodeCursor } from './lib/paginate.js';
export { slugify } from './modules/projects/service.js';
export type { ResolvedTenant } from './types.js';
