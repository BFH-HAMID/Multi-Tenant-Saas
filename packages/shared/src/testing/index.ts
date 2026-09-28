/**
 * Test-only entrypoint (`@saas/shared/testing`).
 *
 * Kept out of the main barrel because it pulls in `vitest` (expect/describe);
 * consumers are test files, never production code paths.
 */
export * from '../ratelimit/conformance.js';
