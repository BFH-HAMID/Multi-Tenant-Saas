-- GENERATED FILE — do not edit.
-- Source of truth: packages/shared/src/ratelimit/lua.ts (TOKEN_BUCKET_LUA)
-- Regenerate with: npm run -w @saas/shared sync:lua
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
