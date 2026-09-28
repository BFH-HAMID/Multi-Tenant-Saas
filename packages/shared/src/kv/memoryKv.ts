import type { KvClient } from './types.js';

interface Entry {
  value: string;
  /** absolute ms; 0 = no expiry */
  expiresAt: number;
}

export interface MemoryKvOptions {
  /** Max live keys; oldest-accessed entries are evicted like `allkeys-lru`. */
  maxEntries?: number;
  now?: () => number;
}

/**
 * In-process stand-in for Redis.
 *
 * This is what makes `npm run dev` work on a machine with no Docker, and it is
 * what the load generator in `tools/loadgen` uses so cache/rate-limit paths are
 * exercised even in environments without a Redis service. It is **not** a
 * substitute for Redis in production: no cross-process visibility, no AOF, no
 * `maxmemory` eviction policy, and lookups share the API's event loop.
 */
export class MemoryKv implements KvClient {
  readonly kind = 'memory' as const;
  private readonly map = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: MemoryKvOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 100_000;
    this.now = opts.now ?? Date.now;
  }

  private live(key: string): Entry | undefined {
    const e = this.map.get(key);
    if (!e) {
      return undefined;
    }
    if (e.expiresAt !== 0 && e.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string): Promise<string | undefined> {
    return this.live(key)?.value;
  }

  async set(key: string, value: string, opts: { ttlMs?: number; nx?: boolean } = {}) {
    if (opts.nx && this.live(key)) {
      return false;
    }
    if (!this.map.has(key) && this.map.size >= this.maxEntries) {
      // Map preserves insertion order; deleting the first key is a cheap,
      // monotonic approximation of LRU for a dev double.
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        this.map.delete(oldest.value);
      }
    }
    this.map.set(key, {
      value,
      expiresAt: opts.ttlMs && opts.ttlMs > 0 ? this.now() + opts.ttlMs : 0,
    });
    return true;
  }

  async del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    let n = 0;
    for (const k of keys) {
      if (this.map.delete(k)) {
        n++;
      }
    }
    return n;
  }

  async incr(key: string): Promise<number> {
    const cur = this.live(key);
    const next = (cur ? Number(cur.value) : 0) + 1;
    if (!Number.isFinite(next)) {
      throw new Error(`value at ${key} is not an integer`);
    }
    this.map.set(key, { value: String(next), expiresAt: cur?.expiresAt ?? 0 });
    return next;
  }

  async exists(key: string): Promise<boolean> {
    return this.live(key) !== undefined;
  }

  async pTtl(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) {
      return -2;
    }
    return e.expiresAt === 0 ? -1 : e.expiresAt - this.now();
  }

  async scan(prefix: string, limit = 100): Promise<string[]> {
    const out: string[] = [];
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix) && this.live(key)) {
        out.push(key);
        if (out.length >= limit) {
          break;
        }
      }
    }
    return out;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
