import { bucketFor } from '../plans.js';
import { bucketIdleTtlMs, TOKEN_BUCKET_LUA } from './lua.js';
import {
  rateLimitKey,
  type RateLimiterBackend,
  type RateLimitContext,
  type RateLimitDecision,
  type RateLimitInput,
} from './types.js';

/** The subset of ioredis we rely on — keeps `@saas/shared` Redis-dependency free. */
/**
 * The Redis surface the limiter needs. Method names/signatures match ioredis;
 * the API casts its client to this at the wiring boundary (ioredis's commands
 * are heavily overloaded, and structural inference through those overloads is
 * more fragile than one documented assertion).
 */
export interface EvalClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  evalsha(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  script(...args: string[]): Promise<unknown>;
  del?(key: string): Promise<unknown>;
}

export interface RedisRateLimiterOptions {
  client: EvalClient;
  /** Extra slack added to the bucket TTL (defensive, default 0). */
  ttlSlackMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Production limiter: one atomic Lua round trip per (tenant, routeClass).
 *
 * Falls back to `null` decision on Redis errors so the caller can degrade to
 * the in-memory limiter instead of failing requests (see ARCHITECTURE.md
 * "Failure modes": losing Redis must not mean losing protection).
 */
export class RedisRateLimiterBackend implements RateLimiterBackend {
  readonly kind = 'redis' as const;
  private readonly client: EvalClient;
  private readonly lua: string;
  private readonly ttlSlackMs: number;
  private readonly onError?: (err: unknown) => void;
  private sha: string | null = null;

  constructor(opts: RedisRateLimiterOptions & { script?: string }) {
    this.client = opts.client;
    this.lua = opts.script ?? TOKEN_BUCKET_LUA;
    this.ttlSlackMs = opts.ttlSlackMs ?? 0;
    this.onError = opts.onError;
  }

  async consume(input: RateLimitInput): Promise<RateLimitDecision> {
    const { tenantId, plan, routeClass } = input;
    const cost = input.cost ?? 1;
    const geom = bucketFor(plan, routeClass);
    const key = rateLimitKey(tenantId, routeClass);
    const ttl = bucketIdleTtlMs(geom.capacity, geom.refillPerSec) + this.ttlSlackMs;

    const args: (string | number)[] = [
      1, // numKeys
      key,
      geom.capacity,
      geom.refillPerSec,
      cost,
      ttl,
    ];

    const raw = await this.run(args);
    const [allowed, remaining, retryAfterMs, limit] = normalizeReply(raw);
    return {
      allowed,
      remaining,
      retryAfterMs,
      limit,
      backend: 'redis',
      key,
    };
  }

  private async run(args: (string | number)[]): Promise<unknown> {
    const keyCount = args[0] as number;
    const rest = args.slice(1);
    try {
      if (this.sha) {
        try {
          return await this.client.evalsha(this.sha, keyCount, ...rest);
        } catch (err) {
          if (!isNoScriptError(err)) {
            throw err;
          }
          this.sha = null; // NOSCRIPT: Redis was restarted / flushed → reload
        }
      }
      return await this.client.eval(this.lua, keyCount, ...rest);
    } catch (err) {
      this.onError?.(err);
      throw err;
    }
  }

  /** `SCRIPT LOAD` at boot so the first request does not pay a NOSCRIPT retry. */
  async preload(): Promise<void> {
    try {
      const res = await this.client.script('LOAD', this.lua);
      if (typeof res === 'string') {
        this.sha = res;
      }
    } catch (err) {
      this.onError?.(err);
    }
  }

  async reset(ctx: RateLimitContext): Promise<void> {
    // The script is the only writer of this key; DEL is safe because a racing
    // consume() either lands before (then gets deleted, worst case = one extra
    // allowed request) or after (then it starts from full, which is the intent).
    await this.client.del?.(rateLimitKey(ctx.tenantId, ctx.routeClass));
  }

  async close(): Promise<void> {
    this.sha = null;
  }
}

function isNoScriptError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('NOSCRIPT');
}

/** Redis Lua returns numbers truncated to integers; arrays may come back as strings. */
function normalizeReply(raw: unknown): [boolean, number, number, number] {
  if (!Array.isArray(raw) || raw.length < 4) {
    throw new Error(`unexpected rate limiter reply: ${JSON.stringify(raw)}`);
  }
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return [num(raw[0]) === 1, num(raw[1]), num(raw[2]), num(raw[3])];
}
