/**
 * Ambient types for `fengari` — a Lua VM in JS, used only by the test suite to
 * execute the real `TOKEN_BUCKET_LUA` source without provisioning Redis. The
 * package ships no types; this declares exactly the slice of the C API the
 * sandbox in `helpers/luaRunner.ts` touches, so a new call there has to be
 * declared deliberately instead of silently becoming `any`.
 */
declare module 'fengari' {
  /** An opaque Lua interpreter state. */
  export interface LuaState {
    __brand: 'lua_State';
  }

  export const lua: {
    LUA_OK: number;
    lua_gettop(L: LuaState): number;
    lua_settop(L: LuaState, index: number): void;
    lua_pop(L: LuaState, n: number): void;
    lua_createtable(L: LuaState, narr: number, nrec: number): void;
    lua_pushstring(L: LuaState, s: Uint8Array): void;
    lua_pushinteger(L: LuaState, n: number): void;
    lua_pushboolean(L: LuaState, b: boolean): void;
    lua_pushjsfunction(L: LuaState, fn: (L: LuaState) => number): void;
    lua_rawlen(L: LuaState, index: number): number;
    lua_rawgeti(L: LuaState, index: number, n: number): number;
    lua_rawseti(L: LuaState, index: number, n: number): void;
    lua_setfield(L: LuaState, index: number, key: Uint8Array): void;
    lua_setglobal(L: LuaState, name: Uint8Array): void;
    lua_pcall(L: LuaState, nargs: number, nresults: number, msgh: number): number;
    lua_tojsstring(L: LuaState, index: number): string | null;
    lua_tonumber(L: LuaState, index: number): number;
    lua_isnumber(L: LuaState, index: number): boolean;
    lua_istable(L: LuaState, index: number): boolean;
  };

  export const lauxlib: {
    luaL_newstate(): LuaState;
    luaL_loadstring(L: LuaState, source: Uint8Array): number;
  };

  export const lualib: {
    luaL_openlibs(L: LuaState): void;
  };

  export function to_luastring(s: string, cache?: boolean): Uint8Array;
  export function to_jsstring(s: Uint8Array, luaToJs?: number): string;
}
