import { defineConfig } from 'vitest/config';

/**
 * Service-backed tests: need PostgreSQL (and Redis for the Lua limiter / BullMQ
 * specs). They are skipped automatically when `DATABASE_URL` is absent so that
 * `npm test` works on a bare laptop; CI runs them with service containers.
 *
 *   make compose-up && npm run test:integration
 */
export default defineConfig({
  test: {
    name: 'integration',
    environment: 'node',
    include: ['**/tests/**/*.int.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // RLS/concurrency specs share one database; serialising files avoids
    // cross-test interference on global state (policies, GUCs, sequences).
    fileParallelism: false,
    restoreMocks: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
