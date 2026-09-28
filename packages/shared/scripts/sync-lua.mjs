#!/usr/bin/env node
/**
 * Extracts the Redis Lua scripts embedded in TypeScript into infra/redis/ so
 * ops can `redis-cli --eval` them, and CI can diff them. `packages/shared/tests/
 * luaParity.test.ts` fails if the checked-out copy drifts from the source of
 * truth, so this file only ever needs running after you edit the TS.
 *
 *   node packages/shared/scripts/sync-lua.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKEN_BUCKET_LUA } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../../../infra/redis/token-bucket.lua');
const banner = `-- GENERATED FILE — do not edit.\n-- Source of truth: packages/shared/src/ratelimit/lua.ts (TOKEN_BUCKET_LUA)\n-- Regenerate with: npm run -w @saas/shared sync:lua\n`;
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${banner}${TOKEN_BUCKET_LUA.replace(/^\n/, '')}`, 'utf8');
console.log(`wrote ${target} (${TOKEN_BUCKET_LUA.length} chars)`);
