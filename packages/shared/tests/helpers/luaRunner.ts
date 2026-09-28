import { lauxlib, lua, lualib, to_luastring } from 'fengari';

/**
 * A ~100 line Redis-Lua sandbox: runs the *actual* `TOKEN_BUCKET_LUA` source
 * against an in-memory hash store, with a controllable clock.
 *
 * Why this exists: the Lua script is the production rate limiter, and a Lua
 * syntax error or an integer/float slip there is the kind of bug that only shows
 * up as "free plan got 300% of pro's quota" in production. Running it in CI
 * without provisioning a Redis service keeps the parity test in the *unit*
 * suite (fast, deterministic) while still testing the real artifact, not a
 * transcription of it. The apps/api integration suite additionally runs it on
 * real Redis.
 *
 * FIDELITY NOTE (important, and the reason tests use small timestamps): fengari
 * implements Lua 5.3, where `tonumber("1700000000")` yields a 64-bit *integer*
 * and multiplication is done with 32-bit JS semantics, so values above 2^31
 * wrap. Redis embeds Lua 5.1, where every number is a double and 1.7e12 is
 * exact. Our bucket math is time-*relative*, so tests use timestamps below
 * 2^31 ms and the sandbox stays faithful; runLuaScript throws rather than
 * silently comparing against a wrapped clock. (Real Redis behaviour for this
 * same script is asserted in apps/api/tests/redisLimiter.int.test.ts.)
 *
 * Semantics deliberately copied from Redis:
 *   - `redis.call` returns Lua *strings* for bulk replies (so the script must
 *     tonumber() them) and `false` for missing hash fields,
 *   - numbers returned from the script are truncated to integers by Redis,
 *   - `TIME` returns { seconds, microseconds }.
 */

export interface LuaHash {
  /** field → value (always stored as strings, like Redis) */
  fields: Map<string, string>;
  pexpireAt: number | null;
}

export interface LuaStore {
  hashes: Map<string, LuaHash>;
  nowMs: number;
  calls: string[];
}

/** fengari's lua_State is opaque at the type level; this is how the client
 *  functions are typed, so we reuse their parameter type instead of `any`. */
export type LuaState = Parameters<typeof lua.lua_tojsstring>[0];

export function createStore(nowMs = 1_700_000_000_000): LuaStore {
  return { hashes: new Map(), nowMs, calls: [] };
}

export function seedBucket(
  store: LuaStore,
  key: string,
  tokensMilli: number,
  updatedAtMs: number,
): void {
  store.hashes.set(key, {
    fields: new Map([
      ['t', String(tokensMilli)],
      ['u', String(updatedAtMs)],
    ]),
    pexpireAt: null,
  });
}

export interface LuaResult {
  reply: number[];
  calls: Array<{ cmd: string; args: string[] }>;
  logs: string[];
}

const SAFE_INT = 2 ** 31 - 1;

export function runLuaScript(
  script: string,
  store: LuaStore,
  keys: string[],
  argv: Array<string | number>,
): LuaResult {
  const unsafe: string[] = [];
  if (store.nowMs > SAFE_INT) {
    unsafe.push(`nowMs=${store.nowMs}`);
  }
  for (const [key, h] of store.hashes) {
    for (const [field, value] of h.fields) {
      if (Math.abs(Number(value)) > SAFE_INT) {
        unsafe.push(`${key}.${field}=${value}`);
      }
    }
  }
  if (unsafe.length > 0) {
    throw new Error(
      `luaRunner: refusing to run with values above 2^31 (fengari integer wrap): ${unsafe.join(', ')}`,
    );
  }

  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  const calls: Array<{ cmd: string; args: string[] }> = [];
  const logs: string[] = [];

  // redis = { call = fn, log = fn }
  lua.lua_createtable(L, 0, 2);

  lua.lua_pushjsfunction(L, (LS: LuaState) => {
    const s = LS;
    const argc = lua.lua_gettop(s);
    const args: string[] = [];
    for (let i = 1; i <= argc; i++) {
      args.push(
        lua.lua_isnumber(s, i) ? String(lua.lua_tonumber(s, i)) : (lua.lua_tojsstring(s, i) ?? ''),
      );
    }
    const cmd = args[0]!;
    calls.push({ cmd, args: args.slice(1) });
    store.calls.push(cmd);
    return pushRedisReply(s, cmd, args.slice(1), store);
  });
  lua.lua_setfield(L, -2, to_luastring('call'));

  lua.lua_pushjsfunction(L, (LS: LuaState) => {
    const s = LS;
    logs.push(lua.lua_tojsstring(s, 1) ?? '');
    return 0;
  });
  lua.lua_setfield(L, -2, to_luastring('log'));

  lua.lua_setglobal(L, to_luastring('redis'));

  pushArray(L, 'KEYS', keys);
  pushArray(L, 'ARGV', argv.map(String));

  const status = lauxlib.luaL_loadstring(L, to_luastring(script));
  if (status !== lua.LUA_OK) {
    throw new Error(`lua compile error: ${lua.lua_tojsstring(L, -1)}`);
  }
  const pcall = lua.lua_pcall(L, 0, 1, 0);
  if (pcall !== lua.LUA_OK) {
    throw new Error(`lua runtime error: ${lua.lua_tojsstring(L, -1)}`);
  }

  const reply: number[] = [];
  if (lua.lua_istable(L, -1)) {
    const n = lua.lua_rawlen(L, -1);
    for (let i = 1; i <= n; i++) {
      lua.lua_rawgeti(L, -1, i);
      const v = lua.lua_tonumber(L, -1);
      // Redis truncates Lua numbers to integers on the way out.
      reply.push(Math.trunc(v));
      lua.lua_pop(L, 1);
    }
  }
  return { reply, calls, logs };
}

function pushArray(L: LuaState, name: string, values: string[]): void {
  lua.lua_createtable(L, values.length, 0);
  values.forEach((v, i) => {
    lua.lua_pushstring(L, to_luastring(v));
    lua.lua_rawseti(L, -2, i + 1);
  });
  lua.lua_setglobal(L, to_luastring(name));
}

function hashFor(store: LuaStore, key: string, create: boolean): LuaHash | undefined {
  let h = store.hashes.get(key);
  if (!h && create) {
    h = { fields: new Map(), pexpireAt: null };
    store.hashes.set(key, h);
  }
  return h;
}

function pushRedisReply(L: LuaState, cmd: string, args: string[], store: LuaStore): number {
  switch (cmd) {
    case 'TIME': {
      const sec = Math.floor(store.nowMs / 1000);
      const usec = Math.round((store.nowMs - sec * 1000) * 1000);
      lua.lua_createtable(L, 2, 0);
      lua.lua_pushinteger(L, sec);
      lua.lua_rawseti(L, -2, 1);
      lua.lua_pushinteger(L, usec);
      lua.lua_rawseti(L, -2, 2);
      return 1;
    }
    case 'HMGET': {
      const [key, ...fields] = args;
      const h = hashFor(store, key!, false);
      lua.lua_createtable(L, fields.length, 0);
      fields.forEach((f, i) => {
        const v = h?.fields.get(f);
        if (v === undefined) {
          lua.lua_pushboolean(L, false); // Redis surfaces missing bulk replies as false
        } else {
          lua.lua_pushstring(L, to_luastring(v));
        }
        lua.lua_rawseti(L, -2, i + 1);
      });
      return 1;
    }
    case 'HGET': {
      const [key, field] = args;
      const v = hashFor(store, key!, false)?.fields.get(field!);
      if (v === undefined) {
        lua.lua_pushboolean(L, false);
      } else {
        lua.lua_pushstring(L, to_luastring(v));
      }
      return 1;
    }
    case 'HMSET':
    case 'HSET': {
      const [key, ...rest] = args;
      const h = hashFor(store, key!, true)!;
      let added = 0;
      for (let i = 0; i + 1 < rest.length; i += 2) {
        if (!h.fields.has(rest[i]!)) {
          added++;
        }
        h.fields.set(rest[i]!, String(rest[i + 1]));
      }
      lua.lua_pushinteger(L, added);
      return 1;
    }
    case 'PEXPIRE':
    case 'EXPIRE': {
      const [key, ttl] = args;
      const h = hashFor(store, key!, false);
      if (h) {
        h.pexpireAt = store.nowMs + (cmd === 'PEXPIRE' ? Number(ttl) : Number(ttl) * 1000);
      }
      lua.lua_pushinteger(L, h ? 1 : 0);
      return 1;
    }
    case 'DEL': {
      let n = 0;
      for (const key of args) {
        if (store.hashes.delete(key)) {
          n++;
        }
      }
      lua.lua_pushinteger(L, n);
      return 1;
    }
    default:
      throw new Error(`luaRunner: unsupported redis.call('${cmd}') — extend the sandbox`);
  }
}
