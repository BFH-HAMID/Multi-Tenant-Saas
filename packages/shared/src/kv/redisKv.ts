import type { KvClient } from './types.js';

/** Structural subset of `ioredis` so `@saas/shared` stays client-free. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: 'PX', ms?: number, flag?: 'NX'): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  exists(key: string): Promise<number>;
  pTTL(key: string): Promise<number>;
  scan(
    cursor: number,
    matchArg: 'MATCH',
    pattern: string,
    countArg: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
  ping(): Promise<string>;
  quit(): Promise<'OK'>;
}

export interface RedisKvOptions {
  /** Redis returns errors as thrown rejections; the KV layer must not take the
   *  API down with it, so every op is wrapped and reported here. */
  onError?: (op: string, err: unknown) => void;
  /** Hard ceiling on any single Redis op (fail fast, don't queue behind a stall). */
  timeoutMs?: number;
}

/** Redis-backed KvClient (cache DB). */
export class RedisKv implements KvClient {
  readonly kind = 'redis' as const;

  constructor(
    private readonly redis: RedisLike,
    private readonly opts: RedisKvOptions = {},
  ) {}

  private async guard<T>(op: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.opts.onError?.(op, err);
      return fallback;
    }
  }

  get(key: string): Promise<string | undefined> {
    return this.guard('get', async () => (await this.redis.get(key)) ?? undefined, undefined);
  }

  set(key: string, value: string, opts: { ttlMs?: number; nx?: boolean } = {}): Promise<boolean> {
    return this.guard(
      'set',
      async () => {
        if (opts.ttlMs && opts.ttlMs > 0) {
          const res = opts.nx
            ? await this.redis.set(key, value, 'PX', Math.round(opts.ttlMs), 'NX')
            : await this.redis.set(key, value, 'PX', Math.round(opts.ttlMs));
          return res === 'OK';
        }
        if (opts.nx) {
          return (await this.redis.set(key, value, 'PX', 3_600_000, 'NX')) === 'OK';
        }
        await this.redis.set(key, value);
        return true;
      },
      false,
    );
  }

  del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    return this.guard('del', () => this.redis.del(...keys), 0);
  }

  incr(key: string): Promise<number> {
    return this.guard('incr', () => this.redis.incr(key), 0);
  }

  exists(key: string): Promise<boolean> {
    return this.guard('exists', async () => (await this.redis.exists(key)) > 0, false);
  }

  pTtl(key: string): Promise<number> {
    return this.guard('pTtl', () => this.redis.pTTL(key), -2);
  }

  scan(prefix: string, limit = 100): Promise<string[]> {
    return this.guard(
      'scan',
      async () => {
        const found = new Set<string>();
        let cursor = '0';
        do {
          const [next, keys] = await this.redis.scan(
            Number(cursor),
            'MATCH',
            `${prefix}*`,
            'COUNT',
            Math.min(1000, Math.max(limit, 50)),
          );
          for (const k of keys) {
            found.add(k);
          }
          cursor = next;
          if (found.size >= limit) {
            break;
          }
        } while (cursor !== '0');
        return [...found].slice(0, limit);
      },
      [],
    );
  }

  ping(): Promise<boolean> {
    return this.guard('ping', async () => (await this.redis.ping()) === 'PONG', false);
  }

  close(): Promise<void> {
    return this.guard(
      'close',
      async () => {
        await this.redis.quit();
      },
      undefined,
    );
  }
}
