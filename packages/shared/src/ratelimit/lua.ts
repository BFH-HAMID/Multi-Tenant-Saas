import { createHash } from 'node:crypto';

/**
 * Redis token bucket, executed with EVALSHA (script preloaded at boot).
 *
 * Why Lua instead of `HGET`/`HSET` or `INCR`: the decision depends on a read
 * and a write in the same critical section, and Redis only guarantees atomicity
 * per-command or per-script. A fixed-window `INCR` is atomic but lets a client
 * burn 2x its limit across a window boundary; a sliding-window log needs an
 * unbounded ZSET per tenant. This script keeps O(1) memory per tenant/route
 * while preserving burst shape. See docs/adr/0004-rate-limiting-token-bucket.md.
 *
 * KEYS[1] = rl:{tenantId}:{routeClass}            (hash: t=milliTokens, u=updatedAtMs)
 * ARGV[1] = capacity (tokens)
 * ARGV[2] = refillPerSec
 * ARGV[3] = cost (tokens, >= 1)
 * ARGV[4] = idle ttl in ms (bucket is dropped when a tenant goes quiet)
 *
 * Returns { allowed, remainingTokens, retryAfterMs, capacity }
 *
 * IMPORTANT: this file is the source of truth for the algorithm; the JS mirror
 * lives in ./tokenBucket.ts and `packages/shared/tests/lua-parity.test.ts`
 * runs this exact source in a Lua VM and asserts identical decisions. Keep the
 * two in sync (run `npm run -w @saas/shared sync:lua` to refresh the copy under
 * infra/redis/ that ops uses for `redis-cli --eval` debugging).
 */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSec = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local idleTtlMs = tonumber(ARGV[4])

-- Server-side clock: never trust a caller-supplied timestamp, a client that
-- could set 'now' could refill its own bucket.
local t = redis.call('TIME')
local nowMs = t[1] * 1000 + math.floor(t[2] / 1000)

local capacityMilli = math.floor(capacity * 1000)
local row = redis.call('HMGET', key, 't', 'u')
local tokensMilli
local updatedAtMs
if row[1] and row[2] then
  tokensMilli = tonumber(row[1])
  updatedAtMs = tonumber(row[2])
else
  tokensMilli = capacityMilli
  updatedAtMs = nowMs
end

local elapsed = nowMs - updatedAtMs
if elapsed < 0 then elapsed = 0 end
-- milliTokens = tokens * 1000, so tokens/sec is milliTokens/ms and the elapsed
-- term is a single multiply (matches the JS model, including truncation).
local tokens = tokensMilli + math.floor(elapsed * refillPerSec)
if tokens > capacityMilli then tokens = capacityMilli end

local costMilli = math.floor(cost * 1000)
local allowed = 0
local remaining = 0
local retryAfterMs = 0

if tokens >= costMilli then
  tokens = tokens - costMilli
  allowed = 1
  remaining = math.floor(tokens / 1000)
else
  remaining = 0
  local missing = costMilli - tokens
  if refillPerSec > 0 then
    retryAfterMs = math.ceil(missing / refillPerSec)
  else
    retryAfterMs = 60000
  end
end

redis.call('HMSET', key, 't', tokens, 'u', nowMs)
redis.call('PEXPIRE', key, idleTtlMs)

return { allowed, remaining, retryAfterMs, math.floor(capacity) }
`;

export const TOKEN_BUCKET_SCRIPT_NAME = 'saas:token_bucket';

/** sha1 that ioredis/Redis use to identify the script for EVALSHA. */
export function tokenBucketSha(): string {
  return createHash('sha1').update(TOKEN_BUCKET_LUA, 'utf8').digest('hex');
}

/**
 * Idle TTL for a bucket: long enough that a tenant can't dodge limiting by
 * idling between requests, short enough that Redis memory is proportional to
 * *active* tenants, not to all tenants. 2x the time to fully refill.
 */
export function bucketIdleTtlMs(capacity: number, refillPerSec: number): number {
  if (refillPerSec <= 0) {
    return 3_600_000;
  }
  const fullRefillMs = (capacity / refillPerSec) * 1000;
  return Math.min(3_600_000, Math.max(60_000, Math.ceil(fullRefillMs * 2)));
}
