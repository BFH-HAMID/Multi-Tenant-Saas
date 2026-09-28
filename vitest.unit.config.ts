import { defineConfig } from 'vitest/config';

/**
 * Fast tests: no external services. These run on every commit in CI and are the
 * pre-push feedback loop (they must stay under ~30s).
 */
export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['**/tests/**/*.test.ts'],
    exclude: ['**/tests/**/*.int.test.ts', '**/node_modules/**', '**/dist/**'],
    restoreMocks: true,
    isolate: true,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/shared/src/**', 'apps/*/src/**', 'db/src/**'],
      exclude: ['**/dist/**', '**/*.d.ts'],
    },
  },
});
