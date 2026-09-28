/**
 * Minimal key/value contract shared by the Redis adapter and the in-process
 * dev double. Deliberately tiny: it only has to cover cache-aside,
 * idempotency records, distributed locks and version tags. Anything that needs
 * more (streams, pubsub, Lua) talks to `ioredis` directly.
 *
 * `undefined` (not `null`) means "miss", and every method must be safe to call
 * concurrently.
 */
export interface KvClient {
  readonly kind: 'redis' | 'memory';
  get(key: string): Promise<string | undefined>;
  /** `ttlMs` undefined = no expiry. `nx: true` = only set when absent. */
  set(key: string, value: string, opts?: { ttlMs?: number; nx?: boolean }): Promise<boolean>;
  del(key: string | string[]): Promise<number>;
  incr(key: string): Promise<number>;
  /** Set `key` to `value` with TTL only if absent; used for locks/singleflight. */
  exists(key: string): Promise<boolean>;
  pTtl(key: string): Promise<number>; // -2 no key, -1 no ttl, else ms left
  /** Best-effort prefix scan (used by tests/debug only — never on the hot path). */
  scan(prefix: string, limit?: number): Promise<string[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const LOCK_TTL_MS_DEFAULT = 5_000;
